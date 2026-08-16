'use client';

import { type ApiMeta, DEFAULT_PAGE_SIZE } from '@ff/shared';
import { useCallback, useEffect, useRef, useState } from 'react';

import { ApiError } from './api-client';
import { useSession } from './session';

/**
 * The list mechanics every §8 master screen needs: debounced server-side
 * search, pagination, sorting, pending state, and out-of-order response
 * protection.
 *
 * Extracted after Sea-Air Port so that §13's "same as Sea-Air Port, for X"
 * stays literally true — twenty screens sharing one implementation rather than
 * twenty copies that drift.
 */
export interface MasterListState<TRow, TSort extends string> {
  rows: TRow[];
  meta: ApiMeta;
  isPending: boolean;
  error: string | null;
  searchInput: string;
  setSearchInput: (value: string) => void;
  page: number;
  setPage: (page: number) => void;
  sortBy: TSort;
  sortOrder: 'asc' | 'desc';
  setSort: (sortBy: TSort, sortOrder: 'asc' | 'desc') => void;
  /** Extra query parameters — a type or category filter, say. */
  filters: Record<string, string>;
  setFilter: (key: string, value: string) => void;
  clearFilters: () => void;
  hasFilters: boolean;
  reload: () => Promise<void>;
}

export function useMasterList<TRow, TSort extends string>(
  endpoint: string,
  defaultSort: TSort,
  limit: number = DEFAULT_PAGE_SIZE,
): MasterListState<TRow, TSort> {
  const { authorizedList } = useSession();

  const [rows, setRows] = useState<TRow[]>([]);
  const [meta, setMeta] = useState<ApiMeta>({ page: 1, limit, total: 0, totalPages: 1 });
  const [isPending, setIsPending] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [sortBy, setSortBy] = useState<TSort>(defaultSort);
  const [sortOrder, setSortOrder] = useState<'asc' | 'desc'>('asc');
  const [filters, setFilters] = useState<Record<string, string>>({});

  // §8: search is server-side and debounced.
  useEffect(() => {
    const timer = setTimeout(() => {
      setSearch(searchInput.trim());
      setPage(1);
    }, 300);
    return () => clearTimeout(timer);
  }, [searchInput]);

  const requestIdRef = useRef(0);

  const reload = useCallback(async () => {
    const requestId = ++requestIdRef.current;
    setIsPending(true);

    const params = new URLSearchParams({
      page: String(page),
      limit: String(limit),
      sortBy,
      sortOrder,
    });
    if (search !== '') params.set('search', search);
    for (const [key, value] of Object.entries(filters)) {
      if (value !== '') params.set(key, value);
    }

    try {
      const response = await authorizedList<TRow[]>(`${endpoint}?${params.toString()}`);
      // Typing in the search box fires several requests; a slower earlier one
      // must not overwrite a newer result.
      if (requestId !== requestIdRef.current) return;
      setRows(response.data);
      if (response.meta !== undefined) setMeta(response.meta);
      setError(null);
    } catch (caught) {
      if (requestId !== requestIdRef.current) return;
      setError(
        caught instanceof ApiError ? caught.message : 'Could not load this list. Please try again.',
      );
    } finally {
      if (requestId === requestIdRef.current) setIsPending(false);
    }
  }, [authorizedList, endpoint, filters, limit, page, search, sortBy, sortOrder]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const setFilter = useCallback((key: string, value: string) => {
    setFilters((prev) => ({ ...prev, [key]: value }));
    setPage(1);
  }, []);

  const clearFilters = useCallback(() => {
    setFilters({});
    setSearchInput('');
    setPage(1);
  }, []);

  const setSort = useCallback((next: TSort, order: 'asc' | 'desc') => {
    setSortBy(next);
    setSortOrder(order);
    setPage(1);
  }, []);

  const hasFilters =
    searchInput.trim() !== '' || Object.values(filters).some((value) => value !== '');

  return {
    rows,
    meta,
    isPending,
    error,
    searchInput,
    setSearchInput,
    page,
    setPage,
    sortBy,
    sortOrder,
    setSort,
    filters,
    setFilter,
    clearFilters,
    hasFilters,
    reload,
  };
}
