// WaveGuard — GitHub Actions reminder script
// Runs on schedule, checks Firebase, posts to GroupMe

const FIREBASE_URL  = 'https://waveguard-2026-default-rtdb.firebaseio.com';
const GROUPME_BOT_ID = process.env.GROUPME_BOT_ID;
const DB_ROOT       = 'waveguard2026';

// ── helpers ──────────────────────────────────────────────────
async function dbGet(path) {
  const url = `${FIREBASE_URL}/${DB_ROOT}/${path}.json`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Firebase read failed: ${res.status}`);
  return res.json();
}

async function postGroupMe(text) {
  if (!GROUPME_BOT_ID) { console.error('No GROUPME_BOT_ID set'); return; }
  const res = await fetch('https://api.groupme.com/v3/bots/post', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ bot_id: GROUPME_BOT_ID, text })
  });
  if (!res.ok) console.error('GroupMe post failed:', res.status);
  else console.log('GroupMe message sent:', text.slice(0, 60));
}

function fmt12(t) {
  if (!t) return '';
  const [h, m] = t.split(':').map(Number);
  return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${h >= 12 ? 'PM' : 'AM'}`;
}

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

function nowMinutes() {
  const n = new Date();
  return n.getHours() * 60 + n.getMinutes();
}

function timeToMinutes(t) {
  if (!t) return -1;
  const [h, m] = t.split(':').map(Number);
  return h * 60 + m;
}

// ── main ─────────────────────────────────────────────────────
async function main() {
  console.log('WaveGuard reminder check —', new Date().toISOString());

  let config, guards, shifts, swaps;
  try {
    [config, guards, shifts, swaps] = await Promise.all([
      dbGet('config'),
      dbGet('guards'),
      dbGet('shifts'),
      dbGet('swaps'),
    ]);
  } catch (e) {
    console.error('Failed to fetch Firebase data:', e.message);
    process.exit(1);
  }

  if (!config || !guards || !shifts) {
    console.log('No data yet, skipping.');
    return;
  }

  const reminderHrs = config.reminderHrs || 2;
  const reminderMins = reminderHrs * 60;
  const now = nowMinutes();
  const today = todayStr();

  const guardMap = guards;   // { id: {first, last, ...} }
  const shiftList = Object.values(shifts);
  const swapList  = Object.values(swaps || {});

  // ── 1. SHIFT REMINDERS ───────────────────────────────────
  // Find shifts today where start time is ~reminderMins from now (within a 30-min window)
  const todayShifts = shiftList.filter(s => s.date === today);
  for (const shift of todayShifts) {
    const shiftStart = timeToMinutes(shift.start);
    const diff = shiftStart - now;
    // Fire if within the reminder window (e.g. between 105-135 mins for a 2hr reminder)
    const windowMin = reminderMins - 15;
    const windowMax = reminderMins + 15;
    if (diff < windowMin || diff > windowMax) continue;

    const assigned = shift.assigned || [];
    if (!assigned.length) continue;

    const names = assigned
      .map(id => guardMap[id] ? guardMap[id].first + ' ' + guardMap[id].last : null)
      .filter(Boolean)
      .join(', ');

    const arriveNote = shift.arriveTime
      ? `\n⏰ Arrive by ${fmt12(shift.arriveTime)}`
      : '';
    const noteText = shift.note ? `\n📝 ${shift.note}` : '';

    const msg =
      `⏱ SHIFT REMINDER — ${reminderHrs === 0.5 ? '30 min' : reminderHrs + ' hr'}${reminderHrs > 1 ? 's' : ''} away!\n` +
      `👤 ${names}\n` +
      `🕐 Today ${fmt12(shift.start)} – ${fmt12(shift.end)}` +
      arriveNote + noteText;

    await postGroupMe(msg);
  }

  // ── 2. SWAP / GIVE-AWAY NOTIFICATIONS ────────────────────
  // Post to GroupMe for any swaps that became 'pending' or 'broadcast'
  // in the last 35 minutes (script runs every 30 min, 5 min buffer)
  const cutoff = Date.now() - 35 * 60 * 1000;

  for (const swap of swapList) {
    // Only notify about fresh pending/broadcast swaps
    if (!['pending', 'broadcast'].includes(swap.status)) continue;

    // Use swap.id as a timestamp proxy (newKey() = Date.now() + random)
    const swapTs = parseInt((swap.id || '0').split('_')[0]);
    if (isNaN(swapTs) || swapTs < cutoff) continue;

    const fromGuard = guardMap[swap.from];
    const fromName  = fromGuard ? `${fromGuard.first} ${fromGuard.last}` : 'Someone';
    const shift     = shifts[swap.shiftId];
    const shiftDesc = shift
      ? `${shift.date} ${fmt12(shift.start)}–${fmt12(shift.end)}`
      : 'a shift';

    if (swap.type === 'give' && swap.status === 'broadcast') {
      const msg =
        `📢 SHIFT AVAILABLE!\n` +
        `${fromName} is giving away their shift:\n` +
        `📅 ${shiftDesc}\n` +
        `First to accept in the WaveGuard app gets it!`;
      await postGroupMe(msg);

    } else if (swap.type === 'swap' && swap.status === 'pending') {
      const toGuard = guardMap[swap.to];
      const toName  = toGuard ? `${toGuard.first} ${toGuard.last}` : 'a teammate';
      const msg =
        `🔄 SWAP REQUEST\n` +
        `${fromName} wants to swap a shift with ${toName}.\n` +
        `📅 ${shiftDesc}\n` +
        `Check the WaveGuard app to respond.`;
      await postGroupMe(msg);
    }
  }

  // ── 3. SICK/EMERGENCY ALERTS (posted immediately from app, 
  //       but also catch any posted in last 35 min via event log)
  const eventLog = await dbGet('eventLog').catch(() => null);
  if (eventLog) {
    const recentSick = Object.values(eventLog).filter(e =>
      e.type === 'sick_alert' &&
      parseInt((e.id || '0').split('_')[0]) > cutoff
    );
    for (const evt of recentSick) {
      const msg =
        `🚨 EMERGENCY COVERAGE NEEDED!\n` +
        `${evt.actor} can't make their shift.\n` +
        `If you can cover, accept in the WaveGuard app ASAP!`;
      await postGroupMe(msg);
    }
  }

  console.log('Reminder check complete.');
}

main().catch(e => { console.error('Fatal error:', e); process.exit(1); });
