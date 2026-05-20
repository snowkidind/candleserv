/**
 * candleserv DB bootstrap. Two subcommands:
 *
 *   check   — exit 0 = initialized, 1 = not initialized, 2 = real failure
 *   install — apply schema, seed settings, create admin user, mark setupComplete
 *
 * Installer flow: call `check` first; only invoke `install` if check returned 1.
 *
 * Initialization marker is app_settings.setupComplete='true' in the DB.
 * Single source of truth; no .env coupling.
 */

process.env.TZ = 'UTC'         // must be set before any Date is constructed
import 'dotenv/config'
import { parseArgs } from 'node:util'
import { getPool, query } from './pool.js'
import { createSchema, seedSettings } from './schema.js'
import { createUser, findUserByEmail } from './users.js'
import { grantPermission, PERM_SUPERADMIN } from './permissions.js'
import { setSetting } from './appSettings.js'
import { insertStreamEvent } from './streamEvents.js'

const SCRIPT = '[candleserv db:init]'

const USAGE = `Usage:
  tsx src/db/init.ts check
  tsx src/db/init.ts install \\
    --admin-email=<email> \\
    --admin-password=<pw>           (min 12 chars) \\
    --admin-first-name=<name> \\
    --admin-last-name=<name> \\
    [--min-sources=<n>] \\
    [--alert-webhook-url=<url>]`

async function tableExists(name: string): Promise<boolean> {
  const res = await query(
    `SELECT 1 FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = $1`,
    [name],
  )
  return (res.rowCount ?? 0) > 0
}

async function check(): Promise<0 | 1> {
  if (!(await tableExists('app_settings'))) {
    console.log(`${SCRIPT} not initialized: app_settings table missing`)
    return 1
  }
  const res = await query(
    `SELECT value FROM app_settings WHERE key = 'setupComplete'`,
  )
  if (res.rowCount === 0 || res.rows[0].value !== 'true') {
    console.log(`${SCRIPT} not initialized: setupComplete row absent or != 'true'`)
    return 1
  }
  console.log(`${SCRIPT} initialized`)
  return 0
}

interface InstallArgs {
  adminEmail: string
  adminPassword: string
  adminFirstName: string
  adminLastName: string
  minSources?: string
  alertWebhookUrl?: string
}

function parseInstallArgs(): InstallArgs {
  const { values } = parseArgs({
    args: process.argv.slice(3),
    options: {
      'admin-email':       { type: 'string' },
      'admin-password':    { type: 'string' },
      'admin-first-name':  { type: 'string' },
      'admin-last-name':   { type: 'string' },
      'min-sources':       { type: 'string' },
      'alert-webhook-url': { type: 'string' },
    },
    strict: true,
  })

  const requiredFlags = [
    'admin-email',
    'admin-password',
    'admin-first-name',
    'admin-last-name',
  ] as const

  const missing = requiredFlags.filter((f) => !values[f])
  if (missing.length) {
    console.error(`${SCRIPT} install: missing required flags: ${missing.map((f) => '--' + f).join(', ')}`)
    console.error(USAGE)
    process.exit(1)
  }

  const password = values['admin-password'] as string
  if (password.length < 12) {
    console.error(`${SCRIPT} install: --admin-password must be at least 12 characters`)
    process.exit(1)
  }

  return {
    adminEmail:      values['admin-email'] as string,
    adminPassword:   password,
    adminFirstName:  values['admin-first-name'] as string,
    adminLastName:   values['admin-last-name'] as string,
    minSources:      values['min-sources'],
    alertWebhookUrl: values['alert-webhook-url'],
  }
}

async function install(): Promise<void> {
  const args = parseInstallArgs()

  console.log(`${SCRIPT} install: applying schema`)
  await createSchema()

  console.log(`${SCRIPT} install: seeding default settings`)
  await seedSettings()

  if (args.minSources) {
    await setSetting('minSources', args.minSources)
    console.log(`${SCRIPT} install: minSources = ${args.minSources}`)
  }
  if (args.alertWebhookUrl) {
    await setSetting('alertWebhookUrl', args.alertWebhookUrl)
    console.log(`${SCRIPT} install: alertWebhookUrl set`)
  }

  const existing = await findUserByEmail(args.adminEmail)
  if (existing) {
    throw new Error(
      `admin user ${args.adminEmail} already exists. If candleserv is already initialized, run 'check' first; if state is inconsistent, fix the DB manually before re-running install.`,
    )
  }

  console.log(`${SCRIPT} install: creating admin user ${args.adminEmail}`)
  const admin = await createUser({
    email:     args.adminEmail,
    password:  args.adminPassword,
    firstName: args.adminFirstName,
    lastName:  args.adminLastName,
    isAdmin:   true,
  })

  console.log(`${SCRIPT} install: granting admin permissions`)
  await grantPermission(admin.id, PERM_SUPERADMIN)
  await grantPermission(admin.id, 'CAN_VIEW_CANDLESERV')
  await grantPermission(admin.id, 'CAN_MODIFY_CANDLESERV')

  await insertStreamEvent('candleserv', 'on')

  console.log(`${SCRIPT} install: marking setupComplete`)
  await setSetting('setupComplete', 'true')

  console.log(`${SCRIPT} install: DONE`)
}

async function main(): Promise<void> {
  const subcommand = process.argv[2]

  if (!subcommand || (subcommand !== 'check' && subcommand !== 'install')) {
    console.error(USAGE)
    process.exit(1)
  }

  if (!process.env.DATABASE_URL) {
    console.error(`${SCRIPT} DATABASE_URL is not set (looked in candleserv/.env)`)
    process.exit(2)
  }

  let exitCode = 0
  try {
    if (subcommand === 'check') {
      exitCode = await check()
    } else {
      await install()
    }
  } catch (err) {
    const detail = err instanceof Error ? (err.stack ?? err.message) : String(err)
    console.error(`${SCRIPT} ${subcommand} FAILED:\n${detail}`)
    exitCode = 2
  } finally {
    try { await getPool().end() } catch {}
  }
  process.exit(exitCode)
}

main()
