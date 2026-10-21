import { Pagination } from '@ziee/kit'

interface ListPaginationProps {
  current: number
  total: number
  pageSize: number
  /** Called with the new 1-based page. */
  onChange: (page: number) => void
  /** Called with the new page size (reset to page 1 at the call site). */
  onPageSizeChange: (size: number) => void
  /** Plural noun for the "1-10 of N <noun>" summary (e.g. "users"). */
  itemNoun?: string
  'data-testid': string
  'aria-label'?: string
}

// The ONE pagination used across every list/table. Encapsulates the standard
// labels, page-size options, quick-jumper, total summary and right-aligned
// placement so pages don't re-spell them (and drift apart). Callers pass only
// the data + handlers (+ an optional item noun for the summary).
export function ListPagination({
  current, total, pageSize, onChange, onPageSizeChange, itemNoun,
  'data-testid': testid, 'aria-label': ariaLabel = 'Pagination',
}: ListPaginationProps) {
  return (
    <div className="flex justify-end pt-3">
      <Pagination
        data-testid={testid}
        current={current}
        total={total}
        pageSize={pageSize}
        onChange={onChange}
        onPageSizeChange={onPageSizeChange}
        showSizeChanger
        pageSizeOptions={[5, 10, 20, 50]}
        pageSizeLabel="Page size"
        showQuickJumper
        jumpLabel="Go to page"
        showTotal={(t: number, range: [number, number]) =>
          itemNoun
            ? `${range[0]}-${range[1]} of ${t} ${itemNoun}`
            : `${range[0]}-${range[1]} of ${t}`
        }
        previousLabel="Previous page"
        nextLabel="Next page"
        pageLabel={(p) => `Page ${p}`}
        aria-label={ariaLabel}
      />
    </div>
  )
}
