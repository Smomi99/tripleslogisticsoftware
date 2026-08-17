'use client';

import { COUNTRIES } from '@ff/shared';
import type { SelectHTMLAttributes } from 'react';

import { Select } from './field';

/**
 * Country dropdown — every ISO 3166-1 country, selected rather than typed.
 *
 * A native select rather than a custom combobox on purpose: it gives keyboard
 * type-ahead for free (an operator types "ban" and lands on Bangladesh), works
 * with every screen reader, and needs no open/close state. §12's users spend
 * eight hours a day in these forms, and the fastest control is the one their
 * fingers already know.
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
