import { Router } from 'express';

import { resolveTenant } from '../middleware/resolve-tenant';
import { portalAuthRouter } from './portal-auth.route';

/**
 * The agent portal (docs/AGENT_PORTAL_DESIGN.md).
 *
 * A separate mount from tenantRouter, not a branch inside it. Every router
 * under here authenticates with `authenticatePortal`, which refuses a staff
 * session; every router under tenantRouter uses `authenticate`, which refuses
 * an agent one. Neither is a guard someone has to remember to add — you cannot
 * authenticate at all without choosing a side.
 *
 * Business routes land in Phase 4. Today this is sign-in only.
 */
export const portalRouter: Router = Router();

portalRouter.use(resolveTenant);
portalRouter.use('/auth', portalAuthRouter);
