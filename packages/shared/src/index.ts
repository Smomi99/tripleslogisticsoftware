/**
 * @ff/shared — the single definition of every contract both apps rely on.
 *
 * CLAUDE.md §2: Zod schemas, TS types, permission constants and enums live here
 * and are imported by BOTH the API and the web app. A schema defined inside
 * apps/api or apps/web is a bug — the two sides drift the moment it happens.
 */
export * from './accounts';
export * from './api';
export * from './auth';
export * from './business-matrix';
export * from './agent';
export * from './carrier';
export * from './codes';
export * from './copy-doc';
export * from './commodity';
export * from './countries';
export * from './cost-head';
export * from './currency';
export * from './documentation';
export * from './customer';
export * from './price-email';
export * from './employee';
export * from './financial-statements';
export * from './freight-certificate';
export * from './freight-rate';
export * from './inbound';
export * from './income-statement';
export * from './inquiry';
export * from './ledger';
export * from './local-sales';
export * from './milestone';
export * from './notification-team';
export * from './opening-balance';
export * from './overview';
export * from './performance';
export * from './permissions';
export * from './port';
export * from './portal';
export * from './pre-alert';
export * from './rate-lookups';
export * from './role';
export * from './sales-lead';
export * from './clp';
export * from './iso6346';
export * from './shipment';
export * from './short-name';
export * from './ta-da';
export * from './tariff';
export * from './user';
export * from './vendor';
export * from './vessel';
export * from './vgm-egm';
export * from './quotation';
