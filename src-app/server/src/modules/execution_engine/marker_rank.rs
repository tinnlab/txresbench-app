//! The marker ranking + selection of a learn run (single-marker-choice round 1a)
//! — the app's port of the benchmark's run-time marker rule. One ranking per
//! learn run, on the run endpoint's outcome, computed once at run start from
//! the learn file at the run's decision day, before anything is written.
//!
//! ### Source
//!
//! The port is verbatim from the benchmark's runner (read-only copies, never
//! edited):
//!
//! - `ranking.py` (sha256
//!   `b5e78188dd8ff363749c70ed9d3060c37a9a92d6b342f3eeac3f5aef3575418f`,
//!   2026-10-20 18:05 -0400): [`last_values`] at lines 19-24 (the same-day
//!   rule: stable by day, the later row wins even when its value is empty),
//!   [`score_markers`] at lines 36-83 (the `|C - 0.5|` survival score, `min_n`
//!   10, constant-value and non-finite-C rules, the sort), [`rank_markers`] at
//!   lines 86-91.
//! - `pilot.py` (sha256
//!   `b03a0a3c603e7410cb97fa84851d8ab62c88900de103a15344906da0e92fdd5d`,
//!   2026-11-16 13:08 -0500): `Context.__init__` at lines 138-157 (the unit
//!   cohort at lines 149-154: a baseline draw at `day <= baseline_max_day`
//!   and an on-treatment draw in `(baseline_max_day, L]` of the candidates),
//!   `Context._fold` at lines 174-209 (the ranking patients at line 186, the
//!   `len < 10` refusal at lines 188-190, the coverage `need` + the 80 % cut
//!   at lines 194-202, `top = head(TOP_N)` at line 204), `n_markers_for` at
//!   lines 112-123 (single → 1, k → the declared k, any → TOP_N),
//!   `run_method_cell` at lines 331-334 (who receives the ranked markers),
//!   `TOP_N = 5` at line 49, `COVERAGE_MIN = 0.80` at line 50.
//! - `data.py` (sha256
//!   `a1e4b98d5065de6f21c0cee4e6b2bf3545b9b223b8b5fb1f0c48b57ed77e720d`):
//!   `observed` at lines 562-583 (the survival frame: a patient contributes
//!   when its time and event are finite and the time is after the landmark
//!   `L`; the horizon only picks one copy of those rows).
//!
//! ### The rule (learn runs; every method with no fixed marker list)
//!
//! 1. **Ranking patients** (the runner's cohort ∩ survival frame): a patient
//!    with a numeric draw of a main marker at `day <= baseline_max_day` AND a
//!    numeric draw of a main marker at `baseline_max_day < day <= L` AND the
//!    survival frame (finite time and event, `time > L`). Fewer than 10 →
//!    [`RankingError::TooFew`].
//! 2. **Score** [`ranking.py::score_markers`]: per marker, each ranking
//!    patient's LAST row at `day <= L` (stable by day — on equal days the
//!    later row in the bundle's row order wins, even when its value is empty,
//!    which then counts as missing); `n` = patients with a value; the score is
//!    `|C - 0.5|` of Harrell's C over the ordered pairs i with `event_i == 1`
//!    and `t_i < t_j` that both carry a value (higher value = higher risk,
//!    equal values = 1/2 a concordance), 0 when `n < 10`, when all values are
//!    equal, or when C is not finite (no comparable pair). Computed in `f64`.
//! 3. **Order**: score desc, n desc, name asc.
//! 4. **Coverage**: a marker is offered only when `n >= max(10,
//!    ceil(0.80 * ranking_patients))`; none → [`RankingError::NoCoverage`].
//! 5. **Top**: the first [`TOP_N`] offered markers ([`MarkerRanking::top`]).
//! 6. **Who gets what** ([`markers_for`]): single → the top 1; multi k → the
//!    top k (the runner gives a declared k exactly k); any → the top 5. The
//!    person's choice ([`SingleMarkerChoice`]) leads with the chosen marker;
//!    with no ranking at all a single method needs none (the chosen marker
//!    alone) and a multi/any method gets only the chosen marker (the count
//!    check then decides).

use std::collections::{BTreeMap, BTreeSet};

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::modules::execution_engine::types::TxrEndpoint;
use crate::modules::file_validator::types::CanonicalBundle;
use crate::modules::method_catalogue::eligibility::is_companion;
use crate::modules::method_catalogue::types::{MarkerKind, RequiredMarkers};

/// The runner's `TOP_N = 5` (pilot.py:49): the run's top markers are the
/// first 5 offered ones.
pub const TOP_N: usize = 5;

/// The runner's `COVERAGE_MIN = 0.80` (pilot.py:50, user rule of 2026-10-21):
/// a marker is offered only when it is measured by L in >= 80 % of the
/// eligible patients.
pub const COVERAGE_MIN: f64 = 0.80;

/// The runner's 10-patient floor (pilot.py:188): fewer ranking patients → no
/// ranking; and a marker with fewer than 10 patients with a value scores 0.
pub const MIN_PATIENTS: usize = 10;

/// The person's choice of how the no-list methods get their markers
/// (step 3 of the app's study wizard; the runner knows only the ranked rule).
/// Wire form: serde `mode` tag with snake_case values (`{"mode": "ranked"}`,
/// `{"mode": "chosen", "marker": "…"}`, `{"mode": "leave_out"}`). Absent on
/// `RunConfig` = `Ranked`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "mode", rename_all = "snake_case")]
pub enum SingleMarkerChoice {
    /// The ranked markers (the runner's rule, the default).
    Ranked,
    /// The user's marker leads; the rest follow the offered ranking without
    /// it (the app's own addition — the benchmark's `primary_marker` override
    /// moves the chosen marker to the front of the ranking).
    Chosen { marker: String },
    /// No-list methods are not run.
    LeaveOut,
}

impl SingleMarkerChoice {
    /// The `rule` value of `marker_choice.json`.
    pub fn rule(&self) -> &'static str {
        match self {
            SingleMarkerChoice::Ranked => "ranked",
            SingleMarkerChoice::Chosen { .. } => "chosen",
            SingleMarkerChoice::LeaveOut => "leave_out",
        }
    }
}

/// One ranked marker (ranking.py's `(feature, score, n)` row plus the app's
/// coverage fraction, pilot.py:197).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct RankedMarker {
    pub marker: String,
    pub score: f64,
    pub n: usize,
    /// `n / ranking_patients` (pilot.py:197).
    pub coverage: f64,
}

/// One learn run's ranking (the runner's `_fold` `ranking` / `markers` /
/// `ranking_patients` facts), for every marker that carried at least one draw.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct MarkerRanking {
    /// Every ranked main marker, score desc / n desc / name asc, with its
    /// score, n and coverage — including a marker too few patients measured
    /// (the runner keeps it at score 0; it is simply not offered).
    pub ranking: Vec<RankedMarker>,
    /// The offered markers (n ≥ the coverage cut), in ranking order.
    pub offered: Vec<String>,
    /// The first [`TOP_N`] offered markers.
    pub top: Vec<String>,
    /// The count of ranking patients.
    pub ranking_patients: usize,
}

/// Why a learn run has no ranking result.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RankingError {
    /// Fewer than [`MIN_PATIENTS`] ranking patients (pilot.py:188).
    TooFew { n: usize },
    /// No marker is measured by L in >= 80 % of the ranking patients
    /// (pilot.py:200-202).
    NoCoverage,
    /// The file has no usable time/event column for the run endpoint.
    NoOutcome { endpoint: TxrEndpoint },
}

impl RankingError {
    /// The run-record code (`marker_choice.json`'s `error`, the same vocabulary
    /// as the [`BundleError`](crate::modules::execution_engine::bundle::BundleError)
    /// codes the method rows carry).
    pub fn code(&self) -> &'static str {
        match self {
            RankingError::TooFew { .. } => "BUNDLE_MARKER_RANKING_TOO_FEW",
            RankingError::NoCoverage => "BUNDLE_MARKER_RANKING_NO_COVERAGE",
            RankingError::NoOutcome { .. } => "BUNDLE_MARKER_RANKING_NO_OUTCOME",
        }
    }

    /// The wire code (the ReasonCode convention — no `BUNDLE_` prefix, as the
    /// eligibility reason codes are spelled): the route's `error.code` and the
    /// eligibility plan block's `error.code`.
    pub fn wire_code(&self) -> &'static str {
        match self {
            RankingError::TooFew { .. } => "MARKER_RANKING_TOO_FEW",
            RankingError::NoCoverage => "MARKER_RANKING_NO_COVERAGE",
            RankingError::NoOutcome { .. } => "MARKER_RANKING_NO_OUTCOME",
        }
    }

    /// The human message (the same text the run-method refusal's detail
    /// renders) — the route's `error.message` / the plan block's.
    pub fn message(&self, decision_day: f64) -> String {
        match self {
            RankingError::TooFew { .. } => format!(
                "Fewer than 10 patients have a draw before and during treatment and a known outcome by day {}, so the markers cannot be ranked.",
                print_day(decision_day)
            ),
            RankingError::NoCoverage => format!(
                "No marker has a value by day {} for at least 8 in 10 of these patients.",
                print_day(decision_day)
            ),
            RankingError::NoOutcome { endpoint } => {
                // The outcome word is the UI's own endpoint word (`SETTING_ENDPOINT_WORD`
                // in `txrrun/lib/settings.ts`), lower-case: the UI says
                // "Progression or death" for pfs and "Death" for os, which is
                // not the draft's "progression"/"survival", so the UI's words
                // are used.
                let word = match endpoint {
                    TxrEndpoint::Pfs => "progression or death",
                    TxrEndpoint::Os => "death",
                };
                format!("The file has no {word} times, so the markers cannot be ranked.")
            }
        }
    }

    /// The wire form: code + message (decision day needed for the message of
    /// the too-few / no-coverage refusals).
    pub fn wire(&self, decision_day: f64) -> PlanError {
        PlanError {
            code: self.wire_code().to_string(),
            message: self.message(decision_day),
        }
    }
}

/// Print a day the way the app prints days elsewhere (`num_cell`): integer
/// when whole ("56"), decimal otherwise ("238.5").
pub fn print_day(day: f64) -> String {
    let s = format!("{day}");
    if s == "-0" {
        "0".to_string()
    } else {
        s
    }
}

/// The run's ONE marker plan: the choice + the ranking result (or its error),
/// computed once at run start from the learn file, the decision day, the
/// baseline maximum and the run endpoint.
#[derive(Debug, Clone, PartialEq)]
pub struct MarkerPlan {
    pub choice: SingleMarkerChoice,
    pub endpoint: TxrEndpoint,
    pub decision_day: f64,
    pub baseline_max_day: f64,
    /// The ranking, or the reason there is none. `NoOutcome` is raised here
    /// (no usable time/event column); the ranking itself raises
    /// [`RankingError::TooFew`] / [`RankingError::NoCoverage`].
    pub result: Result<MarkerRanking, RankingError>,
}

impl MarkerPlan {
    /// The wire [`PlanBlock`] of this plan — the same block shape the
    /// eligibility/preview engines take on an [`InventoryEligibilityRequest`]
    /// (what the UI copies from the ranking route): the choice, the
    /// `top`/`offered` markers and the error when there is no ranking result.
    /// The run create path attaches it to the inventory it classifies with,
    /// so the eligibility verdicts and the run agree (audit fix 1).
    pub fn block(&self) -> PlanBlock {
        let mode = match self.choice {
            SingleMarkerChoice::Ranked => PlanMode::Ranked,
            SingleMarkerChoice::Chosen { .. } => PlanMode::Chosen,
            SingleMarkerChoice::LeaveOut => PlanMode::LeaveOut,
        };
        let marker = match &self.choice {
            SingleMarkerChoice::Chosen { marker } => Some(marker.clone()),
            _ => None,
        };
        match &self.result {
            Ok(ranking) => PlanBlock {
                mode,
                marker,
                top: Some(ranking.top.clone()),
                offered: Some(ranking.offered.clone()),
                error: None,
            },
            Err(e) => PlanBlock {
                mode,
                marker,
                top: None,
                offered: None,
                error: Some(e.wire(self.decision_day)),
            },
        }
    }
}

/// The wire view of a plan — the `marker_plan` block the eligibility /
/// preview requests carry (the UI copies it from the ranking route's result):
/// the choice + the route's `top` / `offered` markers + the error (code and
/// message) when there is no ranking result.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct PlanBlock {
    /// `ranked` | `chosen` | `leave_out` (the [`SingleMarkerChoice`] mode tag).
    pub mode: PlanMode,
    /// The chosen marker (present exactly for `mode: "chosen"`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub marker: Option<String>,
    /// The route result's offered markers (the ranking would give them).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub top: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub offered: Option<Vec<String>>,
    /// The ranking error (code + message), when there is no ranking result.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<PlanError>,
}

/// The [`PlanBlock`] mode (the wire spelling, snake_case).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum PlanMode {
    Ranked,
    Chosen,
    LeaveOut,
}

impl PlanBlock {
    /// The block as the run engine's [`SingleMarkerChoice`].
    pub fn choice(&self) -> SingleMarkerChoice {
        match self.mode {
            PlanMode::Ranked => SingleMarkerChoice::Ranked,
            PlanMode::Chosen => SingleMarkerChoice::Chosen {
                marker: self.marker.clone().unwrap_or_default(),
            },
            PlanMode::LeaveOut => SingleMarkerChoice::LeaveOut,
        }
    }

    /// The block's top/offered marker lists (empty when the route returned
    /// none — a ranking error carries no markers).
    fn top_or_empty(&self) -> &[String] {
        self.top.as_deref().unwrap_or(&[])
    }

    fn offered_or_empty(&self) -> &[String] {
        self.offered.as_deref().unwrap_or(&[])
    }
}

/// One ranking error on the wire (the route's `error` and the plan block's):
/// the ReasonCode-convention code without the `BUNDLE_` prefix
/// (`MARKER_RANKING_TOO_FEW`, `MARKER_RANKING_NO_COVERAGE`,
/// `MARKER_RANKING_NO_OUTCOME`) + the human message the refusal lines render.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct PlanError {
    pub code: String,
    pub message: String,
}

/// Why the plan refuses a no-list method — [`plan_markers`]'s `Err` (a
/// no-list method never receives a marker the file lacks; the refusals are
/// the run engine's `BUNDLE_*` / the eligibility engine's `ReasonCode`s).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PlanRefusal {
    /// The person chose to leave the no-list methods out
    /// (`SingleMarkerChoice::LeaveOut`).
    LeftOut,
    /// The chosen marker is not one of the file's main markers (absent, or a
    /// companion name) — never a selection holding a marker the file lacks.
    ChosenMarkerNotInFile { marker: String },
    /// No ranking result for the run (`Ranked` only — a `Chosen` method needs
    /// no ranking for its chosen marker).
    RankingUnavailable { code: String, message: String },
}

/// The ONE plan rule over a wire [`PlanBlock`], shared by the eligibility and
/// preview engines: what a no-list method receives under the plan, or why the
/// plan refuses it. `mains` are the file's main marker names (the bundle's
/// feature names / the inventory's keys — the same join-key vocabulary).
/// The run engine's own [`markers_for`] applies the same slice rule from its
/// richer [`MarkerPlan`].
pub fn plan_markers(
    kind: MarkerKind,
    count: u32,
    mains: &[String],
    block: &PlanBlock,
) -> Result<Vec<String>, PlanRefusal> {
    match block.choice() {
        SingleMarkerChoice::LeaveOut => Err(PlanRefusal::LeftOut),
        SingleMarkerChoice::Chosen { marker } => {
            if !mains.iter().any(|m| m == &marker) {
                return Err(PlanRefusal::ChosenMarkerNotInFile { marker });
            }
            Ok(markers_slice(kind, count, &block.choice(), block.top_or_empty(), block.offered_or_empty()))
        }
        SingleMarkerChoice::Ranked => {
            if let Some(error) = &block.error {
                return Err(PlanRefusal::RankingUnavailable {
                    code: error.code.clone(),
                    message: error.message.clone(),
                });
            }
            Ok(markers_slice(kind, count, &block.choice(), block.top_or_empty(), block.offered_or_empty()))
        }
    }
}

/// The main (non-companion) marker names of the bundle, sorted — the runner's
/// candidate set (companions are never candidates or draws).
fn main_markers(bundle: &CanonicalBundle) -> Vec<String> {
    let mut names: Vec<String> = bundle
        .values
        .iter()
        .map(|v| v.feature.clone())
        .filter(|f| !is_companion(f))
        .collect();
    names.sort();
    names.dedup();
    names
}

/// The run endpoint's survival rows of the canonical patients (data.py
/// `observed`'s survival half): every patient with a finite time and event.
/// `None` = no usable column for the endpoint (every patient's pair is
/// missing) — [`RankingError::NoOutcome`].
fn outcome_rows(bundle: &CanonicalBundle, endpoint: TxrEndpoint) -> Option<Vec<(String, f64, i64)>> {
    let mut rows: Vec<(String, f64, i64)> = Vec::new();
    for p in &bundle.patients {
        match endpoint {
            TxrEndpoint::Pfs => {
                if let (Some(t), Some(e)) = (p.pfs_days, p.pfs_event) {
                    rows.push((p.patient_id.clone(), t, e));
                }
            }
            TxrEndpoint::Os => {
                if let (Some(t), Some(e)) = (p.os_days, p.os_event) {
                    rows.push((p.patient_id.clone(), t, e));
                }
            }
        }
    }
    if rows.is_empty() {
        None
    } else {
        Some(rows)
    }
}

/// The one marker plan of a learn run — computed once, at run start, before
/// any preflight or write (single-marker-choice round 1a, PLAN-B step 1).
pub fn plan_for(
    bundle: &CanonicalBundle,
    endpoint: TxrEndpoint,
    decision_day: f64,
    baseline_max_day: f64,
    choice: SingleMarkerChoice,
) -> MarkerPlan {
    let result = match outcome_rows(bundle, endpoint) {
        None => Err(RankingError::NoOutcome { endpoint }),
        Some(outcome) => rank_markers(bundle, &outcome, decision_day, baseline_max_day),
    };
    MarkerPlan {
        choice,
        endpoint,
        decision_day,
        baseline_max_day,
        result,
    }
}

/// One ranking patient's last value at or before `L` (the `None` = the last
/// row's value cell was empty — it still wins the same-day tie).
type LastValue = Option<f64>;

/// Rank the file's main markers against the learn file's outcome (the port of
/// `ranking.py::rank_markers` over the runner's `_fold` cohort/coverage rule):
/// the ranking patients, per-marker last value at `day <= L` (stable by day —
/// the later row in the bundle's row order wins, even when its value is
/// empty), the `|C - 0.5|` score, the score/n/name order, the 80 % coverage
/// cut and the top-[`TOP_N`] offered markers.
///
/// `outcome` carries the endpoint's `(patient_id, time, event)` rows of the
/// canonical patients (finite time and event; the survival frame's `time > L`
/// is applied here). `Err` = no ranking result.
pub fn rank_markers(
    bundle: &CanonicalBundle,
    outcome: &[(String, f64, i64)],
    decision_day: f64,
    baseline_max_day: f64,
) -> Result<MarkerRanking, RankingError> {
    let candidates = main_markers(bundle);
    let candidate_set: BTreeSet<&str> = candidates.iter().map(|s| s.as_str()).collect();

    // The ranking patients: a draw with a value of a candidate at
    // `day <= baseline_max_day` AND one at `baseline_max_day < day <= L`
    // (the runner's cohort, pilot.py:149-154), AND the survival frame
    // (`observed`, data.py:571: finite time and event, time > L).
    let mut base: BTreeSet<&str> = BTreeSet::new();
    let mut ont: BTreeSet<&str> = BTreeSet::new();
    for v in &bundle.values {
        if !candidate_set.contains(v.feature.as_str()) {
            continue;
        }
        if !v.day.is_finite() {
            continue;
        }
        // A draw is a NUMERIC row (data.py `read_values` drops non-finite
        // values; the app's empty value cell is `None`).
        if !v.value.is_some_and(|x| x.is_finite()) {
            continue;
        }
        if v.day > decision_day {
            continue;
        }
        if v.day <= baseline_max_day {
            base.insert(v.patient_id.as_str());
        } else {
            ont.insert(v.patient_id.as_str());
        }
    }
    let ranking_patients: Vec<&str> = outcome
        .iter()
        .filter(|(id, t, _e)| {
            t.is_finite() && *t > decision_day && base.contains(id.as_str()) && ont.contains(id.as_str())
        })
        .map(|(id, _, _)| id.as_str())
        .collect();
    let n_rank = ranking_patients.len();
    if n_rank < MIN_PATIENTS {
        return Err(RankingError::TooFew { n: n_rank });
    }
    let ranking_set: BTreeSet<&str> = ranking_patients.iter().copied().collect();

    // Per candidate and ranking patient: the LAST row at `day <= L` — the
    // bundle's row order IS the stability order, so a later same-day row
    // overwrites an earlier one, empty value included (ranking.py
    // `last_values` lines 19-24; the runner's read_values drops non-finite
    // values BEFORE the ranking, so only a same-day empty cell is a "late"
    // missing value here).
    let mut last: BTreeMap<&str, BTreeMap<&str, LastValue>> = BTreeMap::new();
    for v in &bundle.values {
        if !candidate_set.contains(v.feature.as_str()) {
            continue;
        }
        if !v.day.is_finite() || v.day > decision_day {
            continue;
        }
        if !ranking_set.contains(v.patient_id.as_str()) {
            continue;
        }
        let value = v.value.filter(|x| x.is_finite());
        last.entry(v.patient_id.as_str())
            .or_default()
            .insert(v.feature.as_str(), value);
    }

    let time: Vec<f64> = outcome
        .iter()
        .filter(|(id, _, _)| ranking_set.contains(id.as_str()))
        .map(|(_, t, _)| *t)
        .collect();
    let event: Vec<i64> = outcome
        .iter()
        .filter(|(id, _, _)| ranking_set.contains(id.as_str()))
        .map(|(_, _, e)| *e)
        .collect();

    let mut ranked: Vec<RankedMarker> = Vec::with_capacity(candidates.len());
    for cand in &candidates {
        // The values in the ranking patients' order (the `time`/`event`
        // vectors' order) — pairs are order-invariant, but one order keeps
        // the C computation deterministic.
        let values: Vec<Option<f64>> = ranking_patients
            .iter()
            .map(|id| last.get(*id).and_then(|m| m.get(cand.as_str())).copied().flatten())
            .collect();
        let n = values.iter().filter(|v| v.is_some()).count();
        let score = score_of(&time, &event, &values, n);
        ranked.push(RankedMarker {
            marker: cand.clone(),
            score,
            n,
            coverage: n as f64 / n_rank as f64,
        });
    }

    // score desc, n desc, name asc (ranking.py:83's mergesort keys).
    ranked.sort_by(|a, b| {
        b.score
            .partial_cmp(&a.score)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then(b.n.cmp(&a.n))
            .then(a.marker.cmp(&b.marker))
    });

    // The 80 % coverage cut (pilot.py:196): offered only when
    // n >= max(10, ceil(0.80 * ranking patients)).
    let need = ((COVERAGE_MIN * n_rank as f64).ceil() as usize).max(MIN_PATIENTS);
    let offered: Vec<String> = ranked
        .iter()
        .filter(|r| r.n >= need)
        .map(|r| r.marker.clone())
        .collect();
    if offered.is_empty() {
        return Err(RankingError::NoCoverage);
    }
    let offered_cut = offered.len().min(TOP_N);
    Ok(MarkerRanking {
        ranking: ranked,
        top: offered[..offered_cut].to_vec(),
        offered,
        ranking_patients: n_rank,
    })
}

/// The `|C - 0.5|` score of one marker (ranking.py::score_markers lines
/// 64-81): Harrell's C over the ordered pairs i with `event_i == 1` and
/// `t_i < t_j` where both carry a value, concordant when `x_i > x_j`, equal
/// values count 1/2; 0 when `n < 10`, when all values are equal, or when
/// there is no comparable pair (C not finite).
fn score_of(time: &[f64], event: &[i64], values: &[Option<f64>], n: usize) -> f64 {
    if n < MIN_PATIENTS {
        return 0.0;
    }
    let Some((min, max)) = values
        .iter()
        .flatten()
        .fold(None::<(f64, f64)>, |acc, v| match acc {
            None => Some((*v, *v)),
            Some((lo, hi)) => Some((lo.min(*v), hi.max(*v))),
        })
    else {
        return 0.0;
    };
    if max == min {
        return 0.0;
    }
    let mut num: f64 = 0.0;
    let mut den: f64 = 0.0;
    for i in 0..time.len() {
        if event[i] != 1 {
            continue;
        }
        for j in 0..time.len() {
            if !(time[i] < time[j]) {
                continue;
            }
            let (Some(xi), Some(xj)) = (values[i], values[j]) else {
                continue;
            };
            den += 1.0;
            num += if xi > xj {
                1.0
            } else if xi == xj {
                0.5
            } else {
                0.0
            };
        }
    }
    if den <= 0.0 {
        return 0.0;
    }
    (num / den - 0.5).abs()
}

/// Whether a method has NO fixed marker list — exactly the cases the bundle
/// engine today sends to `file_mains` (`bundle::method_marker_set`'s `_` arm):
/// `single` / `multi` without a `required_markers` list, and `any` WITHOUT
/// one. An `any` method WITH a `required_markers` list is a fixed-list
/// method: it keeps today's behaviour (the file's main markers, no ranking,
/// no plan error, no `markers_used`) — 61 runnable `any` methods have no list
/// and are the ones the ranking's top 5 applies to. `panel` is NOT in scope
/// (audit fix 5): with or without a list it keeps today's behaviour — the
/// file's main markers (the count rule) or its fixed list — never the plan's
/// ranked markers.
pub fn is_no_list(kind: MarkerKind, required: Option<&RequiredMarkers>) -> bool {
    match kind {
        MarkerKind::Any => required.is_none(),
        MarkerKind::Single | MarkerKind::Multi => required.is_none(),
        MarkerKind::Panel => false,
    }
}

/// The markers a no-list method receives from the run's marker plan:
/// single → the top 1; multi k → the top k; any → the top 5
/// (`n_markers_for` + `run_method_cell` lines 331-334); the chosen marker
/// (the app's own mode) leads and the rest follow the offered ranking without
/// it. With `Chosen` a single method needs no ranking (the chosen marker
/// alone); multi/any with no ranking get only the chosen marker (the count
/// check then decides). `Ranked` with no ranking returns the empty list — the
/// caller turns the plan's error into the method's refusal.
pub fn markers_for(kind: MarkerKind, count: u32, plan: &MarkerPlan) -> Vec<String> {
    match &plan.result {
        Ok(ranking) => markers_slice(kind, count, &plan.choice, &ranking.top, &ranking.offered),
        Err(_) => markers_slice(kind, count, &plan.choice, &[], &[]),
    }
}

/// The shared slice rule behind [`markers_for`] (the run engine's plan) and
/// [`plan_markers`] (the eligibility/preview engines' plan block): the ONE
/// `markers_for` + choice logic, so the two never drift. `top`/`offered` are
/// the offered ranking (empty when there is none — a `Chosen` single method
/// still gets its chosen marker). `Panel` is not a no-list kind (audit
/// fix 5) and never reaches this rule; its arm is the defensive top-5 of a
/// hypothetical running plan, kept only because the match must be total.
pub fn markers_slice(
    kind: MarkerKind,
    count: u32,
    choice: &SingleMarkerChoice,
    top: &[String],
    offered: &[String],
) -> Vec<String> {
    let limit = match kind {
        MarkerKind::Single => 1,
        MarkerKind::Multi => count as usize,
        MarkerKind::Any | MarkerKind::Panel => TOP_N,
    };
    // The ranked slice reads the OFFERED order (the runner gives a declared k
    // exactly k — `n_markers_for`; `top` is only the display's first five),
    // so a multi method above 5 still gets its k.
    let ranked: &[String] = if top.len() >= limit { top } else { offered };
    match choice {
        SingleMarkerChoice::Chosen { marker } => {
            let mut out = vec![marker.clone()];
            if kind != MarkerKind::Single {
                let rest: Vec<&String> = offered.iter().filter(|m| *m != marker).collect();
                out.extend(rest.into_iter().take(limit.saturating_sub(1)).cloned());
            }
            out
        }
        SingleMarkerChoice::Ranked | SingleMarkerChoice::LeaveOut => {
            ranked.iter().take(limit).cloned().collect()
        }
    }
}

/// The `source` facts of `marker_choice.json` (the read-only copies' dates and
/// sha256 from PLAN-B): file name, modification date and digest. The date of
/// `data.py` is not recorded in PLAN-B (only its digest), so it is `None`.
pub fn source_facts() -> Vec<MarkerSourceFile> {
    vec![
        MarkerSourceFile {
            file: "ranking.py".to_string(),
            date: Some("2026-10-20 18:05 -0400".to_string()),
            sha256: "b5e78188dd8ff363749c70ed9d3060c37a9a92d6b342f3eeac3f5aef3575418f".to_string(),
        },
        MarkerSourceFile {
            file: "pilot.py".to_string(),
            date: Some("2026-11-16 13:08 -0500".to_string()),
            sha256: "b03a0a3c603e7410cb97fa84851d8ab62c88900de103a15344906da0e92fdd5d".to_string(),
        },
        MarkerSourceFile {
            file: "data.py".to_string(),
            date: None,
            sha256: "a1e4b98d5065de6f21c0cee4e6b2bf3545b9b223b8b5fb1f0c48b57ed77e720d".to_string(),
        },
    ]
}

/// One benchmark-source file fact (`marker_choice.json`'s `source`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct MarkerSourceFile {
    pub file: String,
    /// The benchmark file's modification date (not recorded for `data.py`).
    pub date: Option<String>,
    pub sha256: String,
}

/// The run-dir record `marker_choice.json` (written only for learn runs with
/// at least one no-list method) — the ranking/choice facts the step-4 line,
/// the step-3 card and the studies audit read back.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct MarkerChoiceRecord {
    pub rule: String,
    pub endpoint: TxrEndpoint,
    pub decision_day: f64,
    pub baseline_max_day: f64,
    pub ranking_patients: usize,
    pub ranking: Vec<RankedMarker>,
    pub offered: Vec<String>,
    pub top: Vec<String>,
    /// The ranking-error code, or null.
    pub error: Option<String>,
    /// `{method id: [markers]}` of the run's no-list methods.
    pub methods: BTreeMap<String, Vec<String>>,
    pub source: Vec<MarkerSourceFile>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::modules::execution_engine::bundle::{parse_csv, CsvTable};
    use crate::modules::file_validator::types::{CanonicalBundle, CanonicalValue};
    use std::path::Path;

    fn value(patient: &str, day: f64, feature: &str, v: Option<f64>) -> CanonicalValue {
        CanonicalValue {
            patient_id: patient.to_string(),
            day,
            feature: feature.to_string(),
            value: v,
            unit: None,
        }
    }

    /// Build the canonical bundle's values rows from a CSV text (the parity
    /// fixture's `values.csv` shape: patient_id,day,feature,value).
    fn col<'a>(t: &'a CsvTable, name: &str) -> &'a [String] {
        t.col(name).expect("column present")
    }

    /// One parity case: the fixture folder's CSVs + `case.json` + the Python
    /// generator's `expected.json`.
    struct Case {
        name: String,
        decision_day: f64,
        baseline_max_day: f64,
        bundle: CanonicalBundle,
        outcome: Vec<(String, f64, i64)>,
        expected: serde_json::Value,
    }

    fn load_case(dir: &Path, name: &str) -> Case {
        let values = std::fs::read_to_string(dir.join(name).join("values.csv")).expect("values.csv");
        let outcomes = std::fs::read_to_string(dir.join(name).join("outcomes.csv")).expect("outcomes.csv");
        let case_json: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(dir.join(name).join("case.json")).expect("case.json"))
                .expect("case.json parses");
        let expected: serde_json::Value = serde_json::from_str(
            &std::fs::read_to_string(dir.join(name).join("expected.json")).expect("expected.json"),
        )
        .expect("expected.json parses");

        let vt = parse_csv(&values).expect("values csv parses");
        let mut rows: Vec<CanonicalValue> = Vec::new();
        for r in 0..vt.nrow() {
            let v = crate::modules::execution_engine::bundle::parse_number(&vt.col("value").unwrap()[r]);
            rows.push(CanonicalValue {
                patient_id: vt.col("patient_id").unwrap()[r].to_string(),
                day: crate::modules::execution_engine::bundle::parse_number(&vt.col("day").unwrap()[r])
                    .expect("day numeric"),
                feature: vt.col("feature").unwrap()[r].to_string(),
                value: v.filter(|x| x.is_finite()),
                unit: None,
            });
        }
        let ot = parse_csv(&outcomes).expect("outcomes csv parses");
        let mut outcome: Vec<(String, f64, i64)> = Vec::new();
        for r in 0..ot.nrow() {
            let t = crate::modules::execution_engine::bundle::parse_number(&col(&ot, "time")[r])
                .expect("time numeric");
            let e = crate::modules::execution_engine::bundle::parse_number(&col(&ot, "event")[r])
                .expect("event numeric") as i64;
            outcome.push((col(&ot, "patient_id")[r].to_string(), t, e));
        }
        let bundle = CanonicalBundle {
            patients: outcome
                .iter()
                .map(|(id, t, e)| crate::modules::file_validator::types::CanonicalPatient {
                    patient_id: id.clone(),
                    pfs_days: Some(*t),
                    pfs_event: Some(*e),
                    os_days: None,
                    os_event: None,
                    responder: None,
                    response_day: None,
                    covariates: Vec::new(),
                })
                .collect(),
            values: rows,
            features: Vec::new(),
        };
        Case {
            name: name.to_string(),
            decision_day: case_json["decision_day"].as_f64().expect("decision_day"),
            baseline_max_day: case_json["baseline_max_day"].as_f64().expect("baseline_max_day"),
            bundle,
            outcome,
            expected,
        }
    }

    /// The parity pin (single-marker-choice round 1a, item 6): every fixture
    /// case's ranking (order, scores, n, offered, top, ranking_patients) and
    /// its error equal `expected.json`, which the committed
    /// `tests/fixtures/marker_rank_parity/gen_expected.py` produced by running
    /// the benchmark's copied `ranking.py` on the same CSVs.
    #[test]
    fn parity_with_the_benchmark_runner() {
        let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/marker_rank_parity");
        let mut cases: Vec<String> = std::fs::read_dir(&dir)
            .expect("fixture dir")
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .filter(|n| Path::new(&dir).join(n).is_dir())
            .collect();
        cases.sort();
        assert!(!cases.is_empty(), "at least one parity case");

        for name in cases {
            let case = load_case(&dir, &name);
            let got = rank_markers(
                &case.bundle,
                &case.outcome,
                case.decision_day,
                case.baseline_max_day,
            );
            let exp = &case.expected;
            let exp_error: Option<String> = exp["error"]
                .as_str()
                .map(|s| s.to_string());
            match (got, exp_error) {
                (Ok(r), None) => {
                    assert_eq!(r.ranking_patients, exp["ranking_patients"].as_u64().unwrap() as usize, "{name}: ranking_patients");
                    assert_eq!(r.offered, json_strs(&exp["offered"]), "{name}: offered");
                    assert_eq!(r.top, json_strs(&exp["top"]), "{name}: top");
                    let exp_ranking = exp["ranking"].as_array().expect("ranking array");
                    assert_eq!(r.ranking.len(), exp_ranking.len(), "{name}: ranking len");
                    for (a, b) in r.ranking.iter().zip(exp_ranking) {
                        assert_eq!(a.marker, b["marker"].as_str().unwrap(), "{name}: marker");
                        assert!(
                            (a.score - b["score"].as_f64().unwrap()).abs() < 1e-9,
                            "{name}: {} score {} != {}",
                            a.marker,
                            a.score,
                            b["score"]
                        );
                        assert_eq!(a.n, b["n"].as_u64().unwrap() as usize, "{name}: {} n", a.marker);
                        assert!(
                            (a.coverage - b["coverage"].as_f64().unwrap()).abs() < 1e-9,
                            "{name}: {} coverage",
                            a.marker
                        );
                    }
                }
                (Err(e), Some(code)) => {
                    assert_eq!(e.code(), code, "{name}: error code");
                }
                (Ok(_), Some(code)) => panic!("{name}: expected error {code}, got a ranking"),
                (Err(e), None) => panic!("{name}: expected a ranking, got {}", e.code()),
            }
        }
    }

    fn json_strs(v: &serde_json::Value) -> Vec<String> {
        v.as_array()
            .expect("array")
            .iter()
            .map(|s| s.as_str().expect("string").to_string())
            .collect()
    }

    #[test]
    fn markers_for_slices_per_kind() {
        let plan = plan_from(
            vec![
                ("A".to_string(), 0.5, 12, 1.0),
                ("B".to_string(), 0.4, 12, 1.0),
                ("C".to_string(), 0.3, 12, 1.0),
                ("D".to_string(), 0.2, 12, 1.0),
                ("E".to_string(), 0.1, 12, 1.0),
                ("F".to_string(), 0.0, 10, 1.0),
            ],
        );
        assert_eq!(markers_for(MarkerKind::Single, 1, &plan), vec!["A"]);
        assert_eq!(markers_for(MarkerKind::Multi, 3, &plan), vec!["A", "B", "C"]);
        assert_eq!(markers_for(MarkerKind::Any, 0, &plan), vec!["A", "B", "C", "D", "E"]);
        // A multi k above the top-5 display cut still gets its k: the ranked
        // slice reads the OFFERED order (the runner gives a declared k
        // exactly k), so the 6 offered markers are the plan's slice.
        assert_eq!(
            markers_for(MarkerKind::Multi, 9, &plan),
            vec!["A", "B", "C", "D", "E", "F"]
        );

        // Chosen leads, the rest follow without it.
        let mut chosen = plan.clone();
        chosen.choice = SingleMarkerChoice::Chosen { marker: "C".to_string() };
        assert_eq!(markers_for(MarkerKind::Single, 1, &chosen), vec!["C"]);
        assert_eq!(markers_for(MarkerKind::Multi, 3, &chosen), vec!["C", "A", "B"]);
        assert_eq!(
            markers_for(MarkerKind::Any, 0, &chosen),
            vec!["C", "A", "B", "D", "E"]
        );

        // Chosen with NO ranking: only the chosen marker.
        let mut no_rank = chosen.clone();
        no_rank.result = Err(RankingError::TooFew { n: 4 });
        assert_eq!(markers_for(MarkerKind::Multi, 3, &no_rank), vec!["C"]);
        assert_eq!(markers_for(MarkerKind::Any, 0, &no_rank), vec!["C"]);
        assert_eq!(markers_for(MarkerKind::Single, 1, &no_rank), vec!["C"]);
    }

    /// The audit fix for the runner port: a multi k gets exactly k markers
    /// from a 10-marker file (top carries only the display's 5; the slice
    /// reads the offered order), and any still takes the top 5.
    #[test]
    fn multi_k_gets_k_markers_on_a_ten_marker_file() {
        let plan = plan_from(
            (0..10)
                .map(|i| {
                    let m = format!("M{:02}", i + 1);
                    let score = 0.5 - (i as f64) * 0.01;
                    (m, score, 12, 1.0)
                })
                .collect(),
        );
        assert_eq!(markers_for(MarkerKind::Multi, 6, &plan).len(), 6);
        assert_eq!(
            markers_for(MarkerKind::Multi, 6, &plan),
            vec![
                "M01".to_string(),
                "M02".to_string(),
                "M03".to_string(),
                "M04".to_string(),
                "M05".to_string(),
                "M06".to_string(),
            ]
        );
        // Any and panel keep the top 5.
        assert_eq!(markers_for(MarkerKind::Any, 0, &plan).len(), 5);
        assert_eq!(markers_for(MarkerKind::Panel, 3, &plan).len(), 5);
        // Single stays at the top 1.
        assert_eq!(markers_for(MarkerKind::Single, 1, &plan), vec!["M01".to_string()]);
    }

    fn plan_from(rows: Vec<(String, f64, usize, f64)>) -> MarkerPlan {
        let ranking = MarkerRanking {
            ranking: rows
                .iter()
                .map(|(m, s, n, c)| RankedMarker {
                    marker: m.clone(),
                    score: *s,
                    n: *n,
                    coverage: *c,
                })
                .collect(),
            offered: rows.iter().map(|(m, _, _, _)| m.clone()).collect(),
            top: rows.iter().take(TOP_N).map(|(m, _, _, _)| m.clone()).collect(),
            ranking_patients: 12,
        };
        MarkerPlan {
            choice: SingleMarkerChoice::Ranked,
            endpoint: TxrEndpoint::Pfs,
            decision_day: 28.0,
            baseline_max_day: 0.0,
            result: Ok(ranking),
        }
    }

    #[test]
    #[test]
    fn plan_for_reports_no_outcome_when_the_endpoint_columns_are_absent() {
        use crate::modules::file_validator::types::CanonicalPatient;
        let bundle = CanonicalBundle {
            patients: vec![
                CanonicalPatient {
                    patient_id: "p1".to_string(),
                    pfs_days: None,
                    pfs_event: None,
                    os_days: Some(60.0),
                    os_event: Some(0),
                    responder: None,
                    response_day: None,
                    covariates: Vec::new(),
                },
                CanonicalPatient {
                    patient_id: "p2".to_string(),
                    pfs_days: None,
                    pfs_event: None,
                    os_days: Some(90.0),
                    os_event: Some(0),
                    responder: None,
                    response_day: None,
                    covariates: Vec::new(),
                },
            ],
            values: vec![],
            features: Vec::new(),
        };
        // pfs has no usable column -> NoOutcome.
        let plan = plan_for(&bundle, TxrEndpoint::Pfs, 28.0, 0.0, SingleMarkerChoice::Ranked);
        assert_eq!(
            plan.result,
            Err(RankingError::NoOutcome { endpoint: TxrEndpoint::Pfs })
        );
        assert_eq!(plan.choice, SingleMarkerChoice::Ranked);
        assert_eq!(plan.decision_day, 28.0);
        assert_eq!(plan.baseline_max_day, 0.0);
        // os is usable (the frame needs draws too — none here -> TooFew).
        let plan = plan_for(&bundle, TxrEndpoint::Os, 28.0, 0.0, SingleMarkerChoice::Ranked);
        assert_eq!(plan.result, Err(RankingError::TooFew { n: 0 }));
    }

    #[test]
    fn is_no_list_matches_the_bundle_fallthrough() {
        use crate::modules::method_catalogue::types::RequiredMarker;
        let req = RequiredMarkers {
            markers: vec![RequiredMarker {
                name: "X".to_string(),
                id_system: "LOINC".to_string(),
                id: "x".to_string(),
            }],
            match_mode: crate::modules::method_catalogue::types::MatchMode::All,
            min_fraction: 1.0,
            list_source: "fixture".to_string(),
        };
        assert!(is_no_list(MarkerKind::Any, None), "any with no list is no-list");
        assert!(!is_no_list(MarkerKind::Any, Some(&req)), "any WITH a fixed list is a fixed-list method (it keeps today's file-mains rule)");
        assert!(is_no_list(MarkerKind::Single, None));
        assert!(is_no_list(MarkerKind::Multi, None));
        assert!(!is_no_list(MarkerKind::Single, Some(&req)));
        assert!(!is_no_list(MarkerKind::Multi, Some(&req)));
        assert!(!is_no_list(MarkerKind::Panel, Some(&req)));
        // Audit fix 5: panel is NOT in scope — even a panel WITHOUT a fixed
        // list keeps today's behaviour (file mains + count rule), never the
        // plan's ranked markers.
        assert!(!is_no_list(MarkerKind::Panel, None), "panel without a list still keeps today's rule");
    }

    /// Round 1b: the plan block's wire shape (what the UI copies from the
    /// ranking route onto the eligibility requests) and the shared
    /// [`plan_markers`] rule — each mode, the ranking-error refusal, and the
    /// chosen-marker-not-in-file refusal (a companion name is refused too).
    #[test]
    fn plan_block_wire_and_plan_markers_refusals() {
        use crate::modules::method_catalogue::types::RequiredMarker;
        let _req = RequiredMarkers {
            markers: vec![],
            match_mode: crate::modules::method_catalogue::types::MatchMode::All,
            min_fraction: 1.0,
            list_source: "fixture".to_string(),
        };

        // Wire: {mode, marker?, top?, offered?, error?} — the same mode tag
        // values as SingleMarkerChoice.
        let block: PlanBlock = serde_json::from_value(serde_json::json!({
            "mode": "chosen", "marker": "LDH",
            "top": ["LDH", "CEA", "CA199"],
            "offered": ["LDH", "CEA", "CA199"]
        }))
        .unwrap();
        assert_eq!(block.choice(), SingleMarkerChoice::Chosen { marker: "LDH".to_string() });
        assert_eq!(block.top.as_deref(), Some(&["LDH".to_string(), "CEA".to_string(), "CA199".to_string()][..]));
        let ranked: PlanBlock = serde_json::from_value(serde_json::json!({
            "mode": "ranked", "top": ["LDH", "CEA"], "offered": ["LDH", "CEA"]
        }))
        .unwrap();
        assert_eq!(ranked.choice(), SingleMarkerChoice::Ranked);
        let left: PlanBlock = serde_json::from_value(serde_json::json!({"mode": "leave_out"})).unwrap();
        assert_eq!(left.choice(), SingleMarkerChoice::LeaveOut);
        let with_error: PlanBlock = serde_json::from_value(serde_json::json!({
            "mode": "ranked",
            "error": {"code": "MARKER_RANKING_TOO_FEW", "message": "Fewer than 10 patients ..."}
        }))
        .unwrap();
        assert_eq!(with_error.error.as_ref().map(|e| e.code.as_str()), Some("MARKER_RANKING_TOO_FEW"));

        let mains = vec!["LDH".to_string(), "CEA".to_string(), "CA199".to_string()];

        // Ranked: the shared slice (single → top 1, multi → top k, any
        // → top 5; the ranked fixture carries only the top 2).
        assert_eq!(
            plan_markers(MarkerKind::Single, 1, &mains, &ranked).unwrap(),
            vec!["LDH"]
        );
        assert_eq!(
            plan_markers(MarkerKind::Multi, 3, &mains, &ranked).unwrap(),
            vec!["LDH", "CEA"]
        );

        // Chosen: the marker leads (validated against the file's mains).
        assert_eq!(
            plan_markers(MarkerKind::Single, 1, &mains, &block).unwrap(),
            vec!["LDH"]
        );
        assert_eq!(
            plan_markers(MarkerKind::Multi, 3, &mains, &block).unwrap(),
            vec!["LDH", "CEA", "CA199"]
        );
        assert_eq!(
            plan_markers(MarkerKind::Any, 0, &mains, &block).unwrap(),
            vec!["LDH", "CEA", "CA199"]
        );

        // A chosen marker that is not a file main (absent OR a companion) is
        // refused — never a selection holding a marker the file lacks.
        let mut companion = block.clone();
        companion.marker = Some("LDH__detected".to_string());
        assert_eq!(
            plan_markers(MarkerKind::Single, 1, &mains, &companion),
            Err(PlanRefusal::ChosenMarkerNotInFile { marker: "LDH__detected".to_string() })
        );
        let mut absent = block.clone();
        absent.marker = Some("NOPE".to_string());
        assert_eq!(
            plan_markers(MarkerKind::Any, 0, &mains, &absent),
            Err(PlanRefusal::ChosenMarkerNotInFile { marker: "NOPE".to_string() })
        );

        // LeaveOut refuses every no-list method.
        assert_eq!(
            plan_markers(MarkerKind::Any, 0, &mains, &left),
            Err(PlanRefusal::LeftOut)
        );

        // A ranking error refuses a Ranked method; a Chosen single method
        // still gets its chosen marker (the ranking was never needed).
        assert_eq!(
            plan_markers(MarkerKind::Any, 0, &mains, &with_error),
            Err(PlanRefusal::RankingUnavailable {
                code: "MARKER_RANKING_TOO_FEW".to_string(),
                message: "Fewer than 10 patients ...".to_string()
            })
        );
        let mut chosen_with_error = block.clone();
        chosen_with_error.error = Some(PlanError {
            code: "MARKER_RANKING_TOO_FEW".to_string(),
            message: "Fewer than 10 patients ...".to_string(),
        });
        assert_eq!(
            plan_markers(MarkerKind::Single, 1, &mains, &chosen_with_error).unwrap(),
            vec!["LDH"]
        );
    }

    /// Round 1b: the ranking error's wire code drops the `BUNDLE_` prefix
    /// (the ReasonCode convention) and the message matches the run refusal.
    #[test]
    fn ranking_error_wire_form() {
        let too_few = RankingError::TooFew { n: 4 };
        assert_eq!(too_few.wire_code(), "MARKER_RANKING_TOO_FEW");
        assert_eq!(too_few.code(), "BUNDLE_MARKER_RANKING_TOO_FEW");
        assert!(too_few.message(56.0).starts_with("Fewer than 10 patients"));
        let w = too_few.wire(56.0);
        assert_eq!(w.code, "MARKER_RANKING_TOO_FEW");
        assert!(w.message.contains("day 56"));
        assert_eq!(
            RankingError::NoOutcome { endpoint: TxrEndpoint::Pfs }.wire_code(),
            "MARKER_RANKING_NO_OUTCOME"
        );
        assert_eq!(
            RankingError::NoCoverage.wire_code(),
            "MARKER_RANKING_NO_COVERAGE"
        );
        assert!(RankingError::NoOutcome { endpoint: TxrEndpoint::Pfs }
            .message(56.0)
            .contains("progression or death"));
    }

    #[test]
    fn same_day_later_row_wins_even_empty() {
        // The same-day rule: the later row in the bundle's row order wins,
        // even when its value cell is empty (then the value counts missing).
        let bundle = CanonicalBundle {
            patients: Vec::new(),
            values: vec![
                value("p1", 0.0, "A", Some(1.0)),
                value("p1", 14.0, "A", Some(5.0)),
                value("p2", 0.0, "A", Some(1.0)),
                value("p2", 14.0, "A", Some(2.0)),
                value("p3", 0.0, "A", Some(1.0)),
                value("p3", 14.0, "A", Some(2.0)),
                // p4's later same-day row carries no value: it wins, A is missing.
                value("p4", 0.0, "A", Some(1.0)),
                value("p4", 14.0, "A", Some(5.0)),
                value("p4", 14.0, "A", None),
                value("p5", 0.0, "A", Some(1.0)),
                value("p5", 14.0, "A", Some(2.0)),
                value("p6", 0.0, "A", Some(1.0)),
                value("p6", 14.0, "A", Some(2.0)),
                value("p7", 0.0, "A", Some(1.0)),
                value("p7", 14.0, "A", Some(2.0)),
                value("p8", 0.0, "A", Some(1.0)),
                value("p8", 14.0, "A", Some(2.0)),
                value("p9", 0.0, "A", Some(1.0)),
                value("p9", 14.0, "A", Some(2.0)),
                value("p10", 0.0, "A", Some(1.0)),
                value("p10", 14.0, "A", Some(2.0)),
                value("p11", 0.0, "A", Some(1.0)),
                value("p11", 14.0, "A", Some(2.0)),
                value("p12", 0.0, "A", Some(1.0)),
                value("p12", 14.0, "A", Some(2.0)),
            ],
            features: Vec::new(),
        };
        let outcome: Vec<(String, f64, i64)> = (1..=12)
            .map(|i| {
                let event = if i <= 6 { 1 } else { 0 };
                let t = if i <= 6 { 60.0 } else { 120.0 };
                (format!("p{i}"), t, event)
            })
            .collect();
        let r = rank_markers(&bundle, &outcome, 28.0, 0.0).expect("ranking");
        assert_eq!(r.ranking_patients, 12);
        let a = r.ranking.iter().find(|m| m.marker == "A").unwrap();
        // The empty later row wins for p4: A has 11 patients with a value.
        assert_eq!(a.n, 11);
        assert_eq!(a.coverage, 11.0 / 12.0);
    }

    #[test]
    fn too_few_and_no_coverage_are_reported() {
        let bundle = CanonicalBundle {
            patients: Vec::new(),
            values: vec![
                value("p1", 0.0, "A", Some(1.0)),
                value("p1", 14.0, "A", Some(2.0)),
                value("p2", 0.0, "A", Some(1.0)),
                value("p2", 14.0, "A", Some(2.0)),
            ],
            features: Vec::new(),
        };
        let outcome: Vec<(String, f64, i64)> = vec![
            ("p1".to_string(), 60.0, 1),
            ("p2".to_string(), 60.0, 1),
        ];
        assert_eq!(
            rank_markers(&bundle, &outcome, 28.0, 0.0),
            Err(RankingError::TooFew { n: 2 })
        );
    }

    #[test]
    fn no_coverage_when_every_marker_fails_the_eighty_per_cent_cut() {
        // 12 ranking patients (the cut needs n >= 10); both markers have a
        // value for only 8 of them, so nothing is offered.
        let mut values = Vec::new();
        for i in 1..=12 {
            values.push(value(&format!("p{i}"), 0.0, "A", Some(1.0)));
            values.push(value(&format!("p{i}"), 14.0, "A", Some(2.0)));
            values.push(value(&format!("p{i}"), 0.0, "B", Some(1.0)));
            values.push(value(&format!("p{i}"), 14.0, "B", Some(2.0)));
            if i > 8 {
                // p9..p12 have no value rows at or before L — their draws
                // are baseline-only, so the ranking-patient count is still
                // built on the numeric rows above.
                values.push(value(&format!("p{i}"), 20.0, "A", None));
                values.push(value(&format!("p{i}"), 20.0, "B", None));
            }
        }
        // Ranking patients are the 8 patients with on-treatment values only
        // (the extra non-value rows never qualify a patient for the cohort).
        let mut outcome = Vec::new();
        for i in 1..=8 {
            let event = if i <= 4 { 1 } else { 0 };
            let t = if i <= 4 { 60.0 } else { 120.0 };
            outcome.push((format!("p{i}"), t, event));
        }
        let bundle = CanonicalBundle { patients: Vec::new(), values, features: Vec::new() };
        assert_eq!(rank_markers(&bundle, &outcome, 28.0, 0.0), Err(RankingError::TooFew { n: 8 }));

        // The cut itself: 12 ranking patients, 2 markers, n = 8 each.
        let mut values = Vec::new();
        let mut outcome = Vec::new();
        for i in 1..=12 {
            let event = if i <= 6 { 1 } else { 0 };
            let t = if i <= 6 { 60.0 } else { 120.0 };
            outcome.push((format!("p{i}"), t, event));
            let marker = if i % 2 == 0 { "A" } else { "B" };
            // Every patient draws; only 8 patients carry a value at L.
            values.push(value(&format!("p{i}"), 0.0, marker, Some(1.0)));
            values.push(value(&format!("p{i}"), 14.0, marker, Some(2.0)));
            if i > 8 {
                values.push(value(&format!("p{i}"), 14.0, "A", None));
                values.push(value(&format!("p{i}"), 14.0, "B", None));
            }
        }
        let bundle = CanonicalBundle {
            patients: Vec::new(),
            values,
            features: Vec::new(),
        };
        assert_eq!(
            rank_markers(&bundle, &outcome, 28.0, 0.0),
            Err(RankingError::NoCoverage)
        );
    }
}
