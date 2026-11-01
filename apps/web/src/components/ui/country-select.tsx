'use client';

import { COUNTRIES } from '@ff/shared';
import type { SelectHTMLAttributes } from 'react';

import { Select } from './field';

/**
 * Country dropdown — every ISO 3166-1 country, selected rather than typed.
 *
 * The shared searchable Select: an operator types "ban" and the list is
 * Bangladesh, rather than scrolling 250 names.
 *
 * Stores the country NAME, matching the existing `country` columns (§5, §6).
 * React 19 passes `ref` as an ordinary prop, so react-hook-form's register()
 * spreads straight through — no forwardRef needed.
 */
export interface CountrySelectProps
  extends Omit<SelectHTMLAttributes<HTMLSelectElement>, 'children'> {
  /** Label for the blank option — optional fields use a dash. */
  placeholder?: string;
}

export function CountrySelect({ placeholder, ...props }: CountrySelectProps) {
  return (
    <Select {...props}>
      <option value="">{placeholder ?? 'Choose a country'}</option>
      {COUNTRIES.map((country) => (
        <option key={country.code} value={country.name}>
          {country.name}
        </option>
      ))}
    </Select>
  );
}
