import { type AuthedUser } from './../core/user.ts';
import { roleRank, type Role } from '@pigeon-skin/shared';

export function isAdminRole(role: Role | null): boolean {
  return role !== null && roleRank(role) >= roleRank('admin');
}

export function isAdmin(user: AuthedUser | null): boolean {
  return user !== null && isAdminRole(user.role);
}
