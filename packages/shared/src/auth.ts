import { z } from 'zod';

/** Shared by the login form and the API (CLAUDE.md §2, §9). */
export const loginSchema = z.object({
  username: z.string().trim().min(1, 'Enter your username.'),
  password: z.string().min(1, 'Enter your password.'),
});

export type LoginInput = z.infer<typeof loginSchema>;

export interface AuthenticatedUser {
  /** BigInt ids cross the wire as strings — JSON has no bigint. */
  id: string;
  username: string;
  email: string;
  name: string | null;
  isSuperadmin: boolean;
  roleName: string | null;
  /** Resolved permission keys. Empty for a superadmin, who bypasses the check. */
  permissions: string[];
}

export interface LoginResponse {
  accessToken: string;
  user: AuthenticatedUser;
}
