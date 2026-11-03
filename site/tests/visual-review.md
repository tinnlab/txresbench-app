# Visual review — TxResBench landing page

Owner-gated review record (TESTS.md TEST-11). The reviewer serves
`site/dist/` over a static server and checks the rendered page against the
design board M (the design source named in this node's PLAN.md). The checks
below are the same ones the automated suite asserts structurally
(`site/tests/build.test.mjs`, `site/tests/assets.test.mjs`); this record is
where the pixel-level findings are written.

## How to run the review

Build and serve from the repo root:

```
node scripts/build-landing-site.mjs
python3 -m http.server 8000 --directory site/dist
```

Open `http://localhost:8000/` at 1280x920, then in a responsive-mode panel
at 390x844.

## Checks at 1280px (desktop)

| # | Check | Reviewer note |
|---|---|---|
| V1 | The hero shows the title, lede, the primary download button and the "also for" line; the button renders the real version and size from `site/config.json` and links straight to the release asset | |
| V2 | The paper band, the stat band, every section head and the research notice sit at the design's order and spacing | |
| V3 | The three "See it" screenshots and the Methods chips render with their captions; nothing overflows the 1120px wrap | |
| V4 | The sticky header fits one row at 1280px; every nav anchor is visible without scrolling | |
| V5 | The footer carries the licence, third-party notices and report-a-problem links | |
| V6 | The page is readable with none of the design's example values (version 1.0.0, `310/290/330 MB`, 38 methods, 50 datasets, 3,522 patients, `doi:10.0000`) — all numbers come from `site/config.json` | |

## Checks at 390px (phone)

| # | Check | Reviewer note |
|---|---|---|
| V7 | The header wraps to two rows (brand + Download, then the nav), no anchor is clipped | |
| V8 | The hero stacks: copy, button, then the screenshot; the title is 34px and nothing is cut off | |
| V9 | The download tiles stack one per line; the "also for" line wraps cleanly | |
| V10 | The stat band, chips and privacy features wrap without horizontal scroll | |
| V11 | The research notice and footer stay inside the viewport width | |
