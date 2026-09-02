import { Router } from 'express';

import type { ApiSuccess } from '@ff/shared';

import { HttpError } from '../lib/http-error';
import { resolveTenant } from '../middleware/resolve-tenant';
import { adminRouter } from './admin.route';
import { agentRouter } from './agent.route';
import {
  agentInquiryRouter,
  agentQuoteRouter,
  agentReferenceRouter,
} from './agent-inquiry.route';
import { authRouter } from './auth.route';
import { carrierRouter } from './carrier.route';
import { commodityRouter } from './commodity.route';
import { costHeadRouter } from './cost-head.route';
import { customerRouter } from './customer.route';
import { employeeRouter } from './employee.route';
import { currencyRouter } from './currency.route';
import { freightRateRouter } from './freight-rate.route';
import { inquiryRouter } from './inquiry.route';
import { quotationRouter } from './quotation.route';
import { shipmentRouter } from './shipment.route';
import { shipmentScheduleRouter } from './shipment-schedule.route';
import { shippingOrderRouter } from './shipping-order.route';
import { cargoReceiptRouter } from './cargo-receipt.route';
import { salesLeadRouter } from './sales-lead.route';
import { portRouter } from './port.route';
import { notificationSettingRouter } from './notification-setting.route';
import { rateLookupRouter } from './rate-lookup.route';
import { vendorRouter } from './vendor.route';
import { userRouter } from './user.route';
import { vesselRouter } from './vessel.route';

/**
 * Every tenant-scoped route mounts under this router, so tenant resolution
 * cannot be forgotten on a new endpoint. Business routers are added here from
 * Phase 3 onward, each with its own requirePermission guard (CLAUDE.md §7).
 */
export const tenantRouter: Router = Router();

tenantRouter.use(resolveTenant);

// Sign-in happens before there is a session, so this sits inside the tenant
// router but outside `authenticate`.
tenantRouter.use('/auth', authRouter);

// Settings. Each router authenticates and carries a requirePermission guard on
// every route — §7 calls a route without one a bug.
tenantRouter.use('/setting/ports', portRouter);
tenantRouter.use('/setting/cost-heads', costHeadRouter);
tenantRouter.use('/setting/currencies', currencyRouter);
tenantRouter.use('/setting/vessels', vesselRouter);
tenantRouter.use('/setting/carriers', carrierRouter);
tenantRouter.use('/crm/vendors', vendorRouter);
tenantRouter.use('/setting/commodity-categories', commodityRouter);
// Purchase & Sales lookups (docs/MODULE_PURCHASE_SALES.md §3.1).
tenantRouter.use('/setting/notifications', notificationSettingRouter);
tenantRouter.use('/setting', rateLookupRouter);

// Purchase — rate entry for all three modes (MODULE_PURCHASE_SALES §5.1).
tenantRouter.use('/purchase', freightRateRouter);

// Sales — inquiry capture (MODULE_PURCHASE_SALES §5.4).
tenantRouter.use('/sales', inquiryRouter);
tenantRouter.use('/cs', quotationRouter);
// Customer Service — the shipment file (MODULE_BOOKING_CARGO.md §6.1).
tenantRouter.use('/cs', shipmentRouter);
tenantRouter.use('/cs', shipmentScheduleRouter);
tenantRouter.use('/cs', shippingOrderRouter);
// Operation — cargo receipt (MODULE_BOOKING_CARGO.md §6.7).
tenantRouter.use('/ops', cargoReceiptRouter);
tenantRouter.use('/sales', salesLeadRouter);

// CRM.
tenantRouter.use('/crm/customers', customerRouter);
tenantRouter.use('/crm/agents', agentRouter);
tenantRouter.use('/crm/employees', employeeRouter);
tenantRouter.use('/crm/users', userRouter);

// The one module an agent account can reach. Its routers authenticate with
// authenticateAgent, which refuses a staff session — the mirror of every
// router above, all of which refuse an agent one.
tenantRouter.use('/agent/inquiries', agentInquiryRouter);
tenantRouter.use('/agent/quotes', agentQuoteRouter);
tenantRouter.use('/agent/currencies', agentReferenceRouter);

// §7 superadmin screens.
tenantRouter.use('/admin', adminRouter);

interface TenantContextPayload {
  id: string;
  status: string;
}

/** Which workspace the caller resolved to. Feeds the §12 top bar. */
tenantRouter.get('/context', (req, res) => {
  if (req.tenant === undefined) {
    throw new HttpError(500, 'TENANT_CONTEXT_MISSING', 'Tenant was not resolved.');
  }
  const payload: ApiSuccess<TenantContextPayload> = {
    success: true,
    // BigInt is not JSON-serialisable; ids cross the wire as strings.
    data: { id: req.tenant.id.toString(), status: req.tenant.status },
  };
  res.json(payload);
});
