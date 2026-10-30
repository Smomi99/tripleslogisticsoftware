'use client';

import type { Module } from '@ff/shared';
import {
  ChartColumn,
  Container,
  FileText,
  Globe,
  Headset,
  LayoutDashboard,
  type LucideIcon,
  Megaphone,
  Package,
  Settings,
  ShieldCheck,
  ShoppingCart,
  Users,
  Wallet,
} from 'lucide-react';
import { usePathname } from 'next/navigation';

import { cn } from '@/lib/utils';

import { moduleForPath } from './nav-config';

/**
 * Each module's colour slug and icon.
 *
 * The slug selects a [data-module] block in globals.css, which is where the
 * colours themselves live — nothing here names a colour.
 */
export const MODULE_THEME: Record<Module, { slug: string; icon: LucideIcon }> = {
  PURCHASE: { slug: 'purchase', icon: ShoppingCart },
  SALES: { slug: 'sales', icon: Megaphone },
  CUSTOMER_SERVICE: { slug: 'customer-service', icon: Headset },
  OPERATION: { slug: 'operation', icon: Container },
  DOCUMENTATION: { slug: 'documentation', icon: FileText },
  ACCOUNTS: { slug: 'accounts', icon: Wallet },
  SETTING: { slug: 'setting', icon: Settings },
  CRM: { slug: 'crm', icon: Users },
  ADMIN: { slug: 'admin', icon: ShieldCheck },
  REPORT: { slug: 'report', icon: ChartColumn },
  AGENT: { slug: 'agent', icon: Globe },
  CUSTOMER: { slug: 'customer', icon: Package },
};

/** The module the current page belongs to, or null on the Overview and sign-in. */
export function useCurrentModule(): Module | null {
  return moduleForPath(usePathname());
}

/**
 * The module's icon on a filled tile — the colour mark at the head of every
 * page. The Overview, outside every module, gets the dashboard mark in the
 * brand colour.
 */
export function ModuleBadge({ className }: { className?: string }) {
  const module = useCurrentModule();
  const Icon = module === null ? LayoutDashboard : MODULE_THEME[module].icon;
  return (
    <span
      aria-hidden="true"
      className={cn(
        'flex size-10 shrink-0 items-center justify-center rounded-card bg-linear-135 from-module to-harbour text-white shadow-manifest',
        className,
      )}
    >
      <Icon className="size-5" strokeWidth={2} />
    </span>
  );
}
