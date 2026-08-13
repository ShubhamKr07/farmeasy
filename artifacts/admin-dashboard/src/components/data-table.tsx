import React, { useMemo, useState } from "react";
import { ArrowDown, ArrowUp, ChevronLeft, ChevronRight, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { QueryError } from "@/components/ui/query-error";

export interface Column<T> {
  key: string;
  header: string | (() => React.ReactNode);
  /** Value used for sorting. Required when `sortable` is true. */
  accessor?: (row: T) => string | number;
  /** Custom cell renderer. Defaults to the accessor value. */
  cell?: (row: T) => React.ReactNode;
  sortable?: boolean;
  align?: "left" | "right" | "center";
  className?: string;
}

interface DataTableProps<T> {
  data: T[];
  columns: Column<T>[];
  rowKey: (row: T) => string | number;
  onRowClick?: (row: T) => void;
  pageSize?: number; // default 10; set 0 to disable pagination
  /** When provided, a search input is rendered and rows are filtered by `searchFn`. */
  searchFn?: (row: T, term: string) => boolean;
  searchPlaceholder?: string;
  isLoading?: boolean;
  isError?: boolean;
  onRetry?: () => void;
  errorResource?: string;
  emptyState?: React.ReactNode;
  caption?: string;
}

type SortDir = "asc" | "desc";

/**
 * Reusable table with column sort, optional client-side search, and pagination.
 * Implements the loading/empty/error (§8) and a11y (§10) contracts: sortable
 * headers carry `scope="col"` and aria-sort, icon-only controls are labelled.
 */
export function DataTable<T>({
  data,
  columns,
  rowKey,
  onRowClick,
  pageSize = 10,
  searchFn,
  searchPlaceholder = "Search…",
  isLoading,
  isError,
  onRetry,
  errorResource,
  emptyState,
  caption,
}: DataTableProps<T>) {
  const [sortKey, setSortKey] = useState<string | null>(null);
  const [sortDir, setSortDir] = useState<SortDir>("asc");
  const [page, setPage] = useState(0);
  const [term, setTerm] = useState("");

  const filtered = useMemo(() => {
    if (!searchFn || !term.trim()) return data;
    const t = term.toLowerCase();
    return data.filter((row) => searchFn(row, t));
  }, [data, searchFn, term]);

  const sorted = useMemo(() => {
    if (!sortKey) return filtered;
    const col = columns.find((c) => c.key === sortKey);
    if (!col?.accessor) return filtered;
    const dir = sortDir === "asc" ? 1 : -1;
    return [...filtered].sort((a, b) => {
      const av = col.accessor!(a);
      const bv = col.accessor!(b);
      if (typeof av === "number" && typeof bv === "number") return (av - bv) * dir;
      return String(av).localeCompare(String(bv)) * dir;
    });
  }, [filtered, sortKey, sortDir, columns]);

  const usePaging = pageSize > 0 && sorted.length > pageSize;
  const pageCount = usePaging ? Math.ceil(sorted.length / pageSize) : 1;
  const safePage = Math.min(page, Math.max(0, pageCount - 1));
  const paged = usePaging
    ? sorted.slice(safePage * pageSize, safePage * pageSize + pageSize)
    : sorted;

  const toggleSort = (col: Column<T>) => {
    if (!col.sortable || !col.accessor) return;
    if (sortKey === col.key) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(col.key);
      setSortDir("asc");
    }
  };

  if (isLoading) {
    return (
      <div className="space-y-2">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="h-12 rounded-md bg-muted/40 animate-pulse" />
        ))}
      </div>
    );
  }

  if (isError) {
    return <QueryError resource={errorResource} onRetry={onRetry} />;
  }

  const alignClass = (c: Column<T>) =>
    c.align === "right" ? "text-right" : c.align === "center" ? "text-center" : "text-left";

  return (
    <div className="space-y-3">
      {searchFn && (
        <div className="relative max-w-xs">
          <Search className="absolute left-2.5 top-2.5 h-3.5 w-3.5 text-muted-foreground" />
          <Input
            value={term}
            onChange={(e) => {
              setTerm(e.target.value);
              setPage(0);
            }}
            placeholder={searchPlaceholder}
            className="pl-8 h-9 text-sm"
            aria-label={searchPlaceholder}
          />
        </div>
      )}

      <div className="rounded-md border overflow-hidden">
        <table className="w-full text-sm">
          {caption && <caption className="sr-only">{caption}</caption>}
          <thead>
            <tr className="border-b bg-muted/50">
              {columns.map((col) => {
                const isSorted = sortKey === col.key;
                return (
                  <th
                    key={col.key}
                    scope="col"
                    className={`p-3 font-medium text-muted-foreground ${alignClass(col)} ${col.className ?? ""}`}
                    aria-sort={isSorted ? (sortDir === "asc" ? "ascending" : "descending") : "none"}
                  >
                    {col.sortable ? (
                      <button
                        type="button"
                        className="inline-flex items-center gap-1 hover:text-foreground min-h-[28px]"
                        onClick={() => toggleSort(col)}
                      >
                        {typeof col.header === "function" ? col.header() : col.header}
                        {isSorted &&
                          (sortDir === "asc" ? (
                            <ArrowUp className="h-3 w-3" />
                          ) : (
                            <ArrowDown className="h-3 w-3" />
                          ))}
                      </button>
                    ) : (
                      typeof col.header === "function" ? col.header() : col.header
                    )}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {paged.length === 0 ? (
              <tr>
                <td colSpan={columns.length} className="p-8 text-center text-muted-foreground">
                  {emptyState ?? "No results."}
                </td>
              </tr>
            ) : (
              paged.map((row) => (
                <tr
                  key={rowKey(row)}
                  className={`border-b last:border-0 ${onRowClick ? "cursor-pointer hover:bg-muted/30" : ""}`}
                  onClick={onRowClick ? () => onRowClick(row) : undefined}
                >
                  {columns.map((col) => (
                    <td key={col.key} className={`p-3 ${alignClass(col)} ${col.className ?? ""}`}>
                      {col.cell ? col.cell(row) : col.accessor ? String(col.accessor(row)) : null}
                    </td>
                  ))}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {usePaging && (
        <div className="flex items-center justify-between text-xs text-muted-foreground">
          <span>
            Showing {safePage * pageSize + 1}–{Math.min((safePage + 1) * pageSize, sorted.length)} of {sorted.length}
          </span>
          <div className="flex items-center gap-1">
            <Button
              variant="outline"
              size="sm"
              className="h-8 gap-1"
              onClick={() => setPage((p) => Math.max(0, p - 1))}
              disabled={safePage === 0}
              aria-label="Previous page"
            >
              <ChevronLeft className="h-4 w-4" /> Prev
            </Button>
            <span className="px-2">{safePage + 1} / {pageCount}</span>
            <Button
              variant="outline"
              size="sm"
              className="h-8 gap-1"
              onClick={() => setPage((p) => Math.min(pageCount - 1, p + 1))}
              disabled={safePage >= pageCount - 1}
              aria-label="Next page"
            >
              Next <ChevronRight className="h-4 w-4" />
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
