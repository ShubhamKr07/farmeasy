export type UserRole = "owner" | "admin" | "technician";

export const USER_ROLE_LABELS: Record<UserRole, string> = {
  owner: "Owner",
  admin: "Admin",
  technician: "Technician",
};

export function isPrivileged(role: UserRole): boolean {
  return role !== "technician";
}
