import axios from 'axios'

// ─── BiCom Operation Times → SONIQ Schedule Converter ─────────────────────────
//
// BiCom operation times can be set per: IVR, DID, Ring Group (dial_group),
// ERG (queue), Routes, and Server-level.
//
// BiCom schema:
// {
//   status: 'on' | 'off'          — whether otimes is active for this entity
//   default_dest_ext: '5050'       — where to route when CLOSED
//   default_dest_is_vm: 'yes'/'no' — whether closed dest is voicemail
//   open_days: [                   — regular weekly schedule
//     { day: 'mon', time_from: '09:00', time_to: '17:30', status: 'on' },
//     { day: 'tue', ... }
//   ],
//   closed_dates: [                — specific date overrides (bank hols, xmas etc)
//     { date_from: '2024-12-25', date_to: '2024-12-25',
//       time_from: '00:00', time_to: '23:59',
//       destination: '5050', description: 'Christmas Day' }
//   ],
//   custom_destinations: []        — additional special routing
// }
//
// SONIQ time_check step schema (from existing call flows):
// {
//   id: 'schedule',
//   type: 'time_check',
//   config: {
//     timezone: 'Europe/London',
//     schedule: {
//       monday:    { open: '09:00', close: '17:30', enabled: true },
//       tuesday:   { ... },
//       ...
//       saturday:  { enabled: false },
//       sunday:    { enabled: false },
//     },
//     closed_dates: [
//       { from: '2024-12-25', to: '2024-12-25', label: 'Christmas Day',
//         destination_ext: '5050', is_voicemail: false }
//     ],
//     open_destination: null,   — null = fall through to next step (normal flow)
//     closed_destination_ext: '5050',
//     closed_is_voicemail: false
//   }
// }

export interface BicomOtimes {
  status: string
  greeting?: string
  default_dest_ext?: string
  default_dest_is_vm?: string
  open_days?: Array<{
    day: string
    time_from: string
    time_to: string
    status?: string
  }>
  closed_dates?: Array<{
    date_from: string
    date_to: string
    time_from: string
    time_to: string
    destination?: string
    description?: string
  }>
  custom_destinations?: any[]
}

export interface SoniqScheduleStep {
  id: string
  type: 'time_check'
  config: {
    timezone: string
    schedule: Record<string, { open: string; close: string; enabled: boolean } | { enabled: false }>
    closed_dates: Array<{
      from: string
      to: string
      label: string
      destination_ext: string | null
      is_voicemail: boolean
    }>
    closed_destination_ext: string | null
    closed_is_voicemail: boolean
    otimes_active: boolean
  }
}

const DAY_MAP: Record<string, string> = {
  mon: 'monday', tue: 'tuesday', wed: 'wednesday',
  thu: 'thursday', fri: 'friday', sat: 'saturday', sun: 'sunday',
  monday: 'monday', tuesday: 'tuesday', wednesday: 'wednesday',
  thursday: 'thursday', friday: 'friday', saturday: 'saturday', sunday: 'sunday',
}

const ALL_DAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday']

// Convert BiCom open_days array → SONIQ schedule object
// If open_days is empty/missing, default to Mon-Fri 09:00-17:30
function buildSchedule(openDays: BicomOtimes['open_days']): SoniqScheduleStep['config']['schedule'] {
  const schedule: Record<string, any> = {}

  // Start with all days disabled
  for (const day of ALL_DAYS) {
    schedule[day] = { enabled: false }
  }

  if (!openDays || openDays.length === 0) {
    // Default business hours if no schedule configured
    for (const day of ['monday', 'tuesday', 'wednesday', 'thursday', 'friday']) {
      schedule[day] = { open: '09:00', close: '17:30', enabled: true }
    }
    return schedule
  }

  for (const d of openDays) {
    const dayName = DAY_MAP[d.day?.toLowerCase()] || d.day
    if (!dayName) continue
    const isEnabled = d.status !== 'off' && d.status !== '0' && d.status !== 'false'
    if (isEnabled && d.time_from && d.time_to) {
      schedule[dayName] = {
        open: d.time_from,
        close: d.time_to,
        enabled: true,
      }
    } else {
      schedule[dayName] = { enabled: false }
    }
  }

  return schedule
}

// Build closed_dates array from BiCom closed_dates
function buildClosedDates(closedDates: BicomOtimes['closed_dates']): SoniqScheduleStep['config']['closed_dates'] {
  if (!closedDates || closedDates.length === 0) return []

  return closedDates.map(cd => ({
    from: cd.date_from,
    to: cd.date_to,
    label: cd.description || `Closed ${cd.date_from}${cd.date_to !== cd.date_from ? ` to ${cd.date_to}` : ''}`,
    destination_ext: cd.destination || null,
    is_voicemail: false, // BiCom doesn't store this per-date, resolved separately
    // Store time range too — some are partial-day closures
    time_from: cd.time_from || '00:00',
    time_to: cd.time_to || '23:59',
  }))
}

// Main converter: BiCom otimes → SONIQ time_check workflow step
export function convertOtimesToScheduleStep(
  otimes: BicomOtimes,
  stepId: string = 'schedule'
): SoniqScheduleStep | null {
  // If otimes isn't configured or is off, return null (no schedule step needed)
  if (!otimes || Object.keys(otimes).length === 0) return null

  const isActive = otimes.status === 'on' || otimes.status === '1'

  return {
    id: stepId,
    type: 'time_check',
    config: {
      timezone: 'Europe/London',
      schedule: buildSchedule(otimes.open_days),
      closed_dates: buildClosedDates(otimes.closed_dates),
      closed_destination_ext: otimes.default_dest_ext || null,
      closed_is_voicemail: otimes.default_dest_is_vm === 'yes',
      otimes_active: isActive,
    },
  }
}

// Fetch operation times for a given entity type and ID
export async function fetchOtimes(
  serverUrl: string,
  apiKey: string,
  tenantId: string,
  entityType: 'ivr' | 'did' | 'dial_group' | 'erg' | 'routes',
  entityId: string
): Promise<BicomOtimes | null> {
  try {
    const action = `pbxware.otimes.${entityType}.list`
    const url = `${serverUrl.replace(/\/$/, '')}/index.php`
    const r = await axios.get(url, {
      params: { apikey: apiKey, action, server: tenantId, id: entityId },
      timeout: 10000,
    })
    const data = r.data
    if (!data || Array.isArray(data) && data.length === 0) return null
    if (data.error) return null
    // Data is keyed by entity ID
    const otimes = typeof data === 'object' && !Array.isArray(data)
      ? (data[entityId] || Object.values(data)[0] as BicomOtimes)
      : null
    return otimes || null
  } catch {
    return null
  }
}

// Build a complete call flow workflow_steps array with schedule prepended
// Takes existing steps and inserts schedule check at the front
export function wrapWithSchedule(
  existingSteps: any[],
  otimes: BicomOtimes | null,
  closedFallbackSteps?: any[]
): any[] {
  if (!otimes) return existingSteps

  const scheduleStep = convertOtimesToScheduleStep(otimes)
  if (!scheduleStep) return existingSteps

  // If otimes is active, prepend the schedule check
  // The orchestrator reads time_check and routes accordingly:
  // - Within open hours → continue to next steps (the IVR/ring group)
  // - Outside hours / closed date → route to closed_destination_ext or closed fallback steps
  if (!scheduleStep.config.otimes_active) {
    // Otimes is configured but switched off — store it but don't enforce
    scheduleStep.config.otimes_active = false
  }

  const closedSteps = closedFallbackSteps || [
    {
      id: 'closed_vm',
      type: 'voicemail',
      config: { greeting: 'closed', transcription: true },
    },
  ]

  return [
    scheduleStep,
    // Open branch — normal flow
    { id: 'open_branch', type: 'branch', config: { condition: 'schedule_open', steps: existingSteps } },
    // Closed branch — route to closed destination or voicemail
    { id: 'closed_branch', type: 'branch', config: { condition: 'schedule_closed', steps: closedSteps } },
  ]
}
