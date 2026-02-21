import { query } from "./pool";

export const PERM_SUPERADMIN            = "SUPERADMIN";
export const PERM_CAN_VIEW_CANDLESERV   = "CAN_VIEW_CANDLESERV";
export const PERM_CAN_MODIFY_CANDLESERV = "CAN_MODIFY_CANDLESERV";

export async function getPermissionsForUser(userId: number): Promise<Record<string, boolean>> {
  const res = await query(
    `SELECT perm FROM user_permissions WHERE "userId" = $1`,
    [userId]
  );
  const map: Record<string, boolean> = {};
  for (const row of res.rows) {
    map[row.perm as string] = true;
  }
  return map;
}

export async function grantPermission(userId: number, perm: string): Promise<void> {
  await query(
    `INSERT INTO user_permissions ("userId", perm) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
    [userId, perm]
  );
}

export async function revokePermission(userId: number, perm: string): Promise<void> {
  await query(
    `DELETE FROM user_permissions WHERE "userId" = $1 AND perm = $2`,
    [userId, perm]
  );
}
