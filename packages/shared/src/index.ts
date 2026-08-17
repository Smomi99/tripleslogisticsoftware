/**
 * @ff/shared — the single definition of every contract both apps rely on.
 *
 * CLAUDE.md §2: Zod schemas, TS types, permission constants and enums live here
 * and are imported by BOTH the API and the web app. A schema defined inside
 * apps/api or apps/web is a bug — the two sides drift the moment it happens.
 */
export * from './api';
export * from './auth';
export * from './agent';
export * from './carrier';
export * from './codes';
export * from './commodity';
export * from './cost-head';
export * from './currency';
export * from './customer';
export * from './employee';
export * from './permissions';
export * from './port';
export * from './role';
export * from './user';
export * from './vendor';
export * from './vessel';
