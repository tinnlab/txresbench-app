/**
 * txrintake screen B — the disease picker (step2-filters, brief 5b).
 *
 * Replaces the flat disease `Select`: ONE searchable single-select (the kit
 * `Select` "auto" search arm) whose options are the method catalogue's
 * `filter_options.disease_categories` vocabulary, grouped by category:
 *
 * - the category is the group heading, its diseases under it, and each
 *   disease's sub-groups (`children`) indented beneath the disease;
 * - typing filters by name — a sub-group's row also carries its parent
 *   beside it ("uveal melanoma (melanoma)"), so "melanoma" finds the
 *   disease and its sub-group; only OPTION text matches, never a category
 *   heading (a heading matching "solid" must not offer the whole
 *   "Solid tumours" category);
 * - each category ends with an "Another disease in <category> (not listed)"
 *   option whose VALUE is the category id itself (the server treats a
 *   category id as the category's whole scope);
 * - the kit's clear button is the "Clear" affordance: it commits the empty
 *   value, which this control maps to `null` — the store's unanswered
 *   spelling (`disease_group: null`) — never an empty string;
 * - ids ARE the readable names, so every label is the id with its first
 *   letter upper case (the display rule; nothing else is invented).
 *
 * The control is presentation only: it hands the picked id (or `null`) to
 * the caller, which writes through the registered `intake.setStudyAnswers`
 * action — the same validation path the AI drives.
 */
import { Select } from '@txresbench/kit'
import type { SelectOption, SelectOptionGroup } from '@txresbench/kit'
import type { DiseaseCategory } from '@/api-client/types'

/** The clear button's accessible name (the kit REQUIRES the caller's wording). */
export const DISEASE_CLEAR_LABEL = 'Clear the disease'

/** The id's first letter upper case — the ids are the readable names already,
 *  so this is the ONLY transformation the display makes. */
export function diseaseDisplayName(id: string): string {
  return id.length === 0 ? id : id.charAt(0).toUpperCase() + id.slice(1)
}

/** One disease option, carrying the render indentation as a caller-side field
 *  (the kit's `SelectOption` is the row contract; the extra field is what
 *  `optionRender` reads to indent a sub-group under its disease). */
export interface DiseasePickOption extends SelectOption {
  /** 1 for a disease's sub-group (indented under the disease), absent for the rest. */
  indent?: number
}

export interface TxrDiseasePickerProps {
  /** The current answer id, `null` when unanswered. */
  value: string | null
  /** The loaded disease vocabulary (empty before it loads). */
  categories: DiseaseCategory[]
  /** The picked id — or `null` when the user cleared the answer. */
  onChange: (value: string | null) => void
}

/**
 * The picker's grouped options (one group per category, in the vocabulary's
 * order): each disease, each of its sub-groups (indented, parent beside it),
 * then the category's "Another disease … (not listed)" option carrying the
 * category id.
 *
 * The group HEADING is a React node, not a string — deliberately. The kit's
 * search keeps all of a group's options when the query matches the group
 * HEADING, and this picker must filter by OPTION names only (brief 5b2
 * ITEM-2/4): typing "solid" matches only the "Solid tumours" heading, and
 * listing the whole category for it would be a lie about what was asked
 * ("solid" names no disease). A node heading renders the same text but
 * carries no searchable bytes; the "not listed" row's own label still
 * carries the category word, so it stays the answer for "solid".
 */
export function buildDiseaseOptions(categories: DiseaseCategory[]): SelectOptionGroup[] {
  const groups: SelectOptionGroup[] = []
  for (const category of categories) {
    const options: DiseasePickOption[] = []
    for (const disease of category.diseases) {
      options.push({ value: disease.id, label: diseaseDisplayName(disease.id) })
      for (const child of disease.children) {
        options.push({
          value: child,
          label: `${diseaseDisplayName(child)} (${diseaseDisplayName(disease.id)})`,
          indent: 1,
        })
      }
    }
    options.push({
      value: category.id,
      label: `Another disease in ${diseaseDisplayName(category.id)} (not listed)`,
    })
    groups.push({ label: <>{diseaseDisplayName(category.id)}</>, options })
  }
  return groups
}

export function TxrDiseasePicker({ value, categories, onChange }: TxrDiseasePickerProps) {
  // study-step-ui-tweaks: the box takes the FULL width of the filters column
  // — the trigger fills this wrapper (`w-full` in the kit) and the popup is
  // anchored to the trigger (`min-w-(--anchor-width)`), so the open list is
  // as wide as the trigger at every window width.
  return (
    <div
      data-testid="txr-intake-study-disease-wrap"
      style={{ width: '100%', minWidth: 0 }}
    >
      <Select
        id="txr-intake-study-disease"
        data-testid="txr-intake-study-disease"
        aria-label="Disease"
        value={value ?? undefined}
        onChange={next => onChange(next === '' ? null : next)}
        // A stored id the vocabulary does not (yet) hold — the picker mounted
        // before the filter options landed, or the id is simply unknown — has
        // no option to display, so the kit would render its empty-state prompt
        // (a blank trigger with a clear button, brief 5b2 ITEM-3). Show the
        // stored id as text instead, by the display rule; once the vocabulary
        // loads, an unknown id is already dropped by the store's reconcile
        // (`reconcileStudyWithVocabulary`), so this branch reads the honest
        // pre-load state only.
        labelRender={selected => selected?.label ?? (value !== null ? diseaseDisplayName(value) : undefined)}
        placeholder="Choose a disease…"
        emptyText="No disease matches"
        allowClear
        clearLabel={DISEASE_CLEAR_LABEL}
        options={buildDiseaseOptions(categories)}
        optionRender={option => {
          const indent = (option as DiseasePickOption).indent ?? 0
          return (
            <span
              style={{
                paddingLeft: indent * 18,
                color: indent > 0 ? 'var(--txr-text-2)' : undefined,
              }}
            >
              {option.label}
            </span>
          )
        }}
      />
    </div>
  )
}
