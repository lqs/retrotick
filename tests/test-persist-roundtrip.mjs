// Exercise the REAL IndexedDB persistence chain (idb.ts + profile-db.ts +
// registry-db.ts) with a fake IndexedDB, reproducing EXACTLY the onChange/flush
// wiring and the unmount cleanup from EmulatorView.tsx, to find out whether
// writes survive across a "close + reopen" cycle.

import 'fake-indexeddb/auto';
import { ProfileStore } from '../src/lib/profile-store.ts';
import { RegistryStore } from '../src/lib/registry-store.ts';
import { loadProfiles, saveProfiles } from '../src/lib/profile-db.ts';
import { loadRegistry, saveRegistry } from '../src/lib/registry-db.ts';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// --- Reproduce EmulatorView's mount + cleanup, verbatim wiring ---
function mountEmulatorView() {
  let regFlushTimer = null;
  let profFlushTimer = null;
  let profStore, regStore;

  const init = async () => {
    const [regData, profData] = await Promise.all([
      loadRegistry().catch(() => null),
      loadProfiles().catch(() => null),
    ]);
    regStore = new RegistryStore();
    if (regData) regStore.deserialize(regData);
    regStore.onChange = () => {
      if (regFlushTimer !== null) clearTimeout(regFlushTimer);
      regFlushTimer = setTimeout(() => { saveRegistry(regStore.serialize()).catch(() => {}); }, 500);
    };
    profStore = new ProfileStore();
    if (profData) profStore.deserialize(profData);
    profStore.onChange = () => {
      if (profFlushTimer !== null) clearTimeout(profFlushTimer);
      profFlushTimer = setTimeout(() => { saveProfiles(profStore.serialize()).catch(() => {}); }, 500);
    };
  };

  // Updated cleanup matching the fix: flush (not cancel) pending writes.
  const cleanup = () => {
    if (regFlushTimer !== null) { clearTimeout(regFlushTimer); regFlushTimer = null; }
    if (regStore) saveRegistry(regStore.serialize()).catch(() => {});
    if (profFlushTimer !== null) { clearTimeout(profFlushTimer); profFlushTimer = null; }
    if (profStore) saveProfiles(profStore.serialize()).catch(() => {});
  };

  return { init, cleanup, getProf: () => profStore, getReg: () => regStore };
}

async function readBackProfile() {
  const data = await loadProfiles();
  const ps = new ProfileStore();
  if (data) ps.deserialize(data);
  return ps.getString('win.ini', 'Solitaire', 'Options', '<MISSING>');
}

console.log('=========== SCENARIO A: write, wait >500ms, then close, reopen ===========');
{
  const view = mountEmulatorView();
  await view.init();
  view.getProf().writeString('win.ini', 'Solitaire', 'Options', '42'); // user changes option
  await sleep(700); // user keeps playing past the debounce
  view.cleanup(); // user closes the app window
  await sleep(50);
  const got = await readBackProfile();
  console.log(`  Reopened -> Options = "${got}"  ${got === '42' ? 'PASS ✅' : 'FAIL ❌'}`);
}

console.log('\n=========== SCENARIO B: write on close (WM_DESTROY), then immediate cleanup ===========');
{
  const view = mountEmulatorView();
  await view.init();
  // Simulate sol.exe writing its score in WM_DESTROY, immediately followed by
  // React unmounting the component (cleanup) within the same tick.
  view.getProf().writeString('win.ini', 'Solitaire', 'Options', '99');
  view.cleanup(); // < happens well within 500ms of the write
  await sleep(800); // wait long enough for any surviving timer to fire
  const got = await readBackProfile();
  console.log(`  Reopened -> Options = "${got}"  ${got === '99' ? 'PASS ✅ (timer survived)' : 'FAIL ❌ (write lost)'}`);
}

console.log('\n=========== SCENARIO C: registry write on close, immediate cleanup ===========');
{
  // reset registry portion by reopening fresh store
  const view = mountEmulatorView();
  await view.init();
  // Write a registry value (e.g. an app that stores settings in HKCU)
  const reg = view.getReg();
  const HKCU = 0x80000001; // HKEY_CURRENT_USER
  const created = reg.createKey(HKCU, 'Software\\TestApp');
  if (created) reg.setValue(created.handle, 'HighScore', 4 /*REG_DWORD*/, new Uint8Array([1, 2, 3, 4]));
  view.cleanup(); // with the fix, this flushes instead of cancelling
  await sleep(800);
  const data = await loadRegistry();
  const rs = new RegistryStore();
  if (data) rs.deserialize(data);
  let found = '<n/a>';
  try {
    const h = rs.openKey(HKCU, 'Software\\TestApp');
    const v = h ? rs.queryValue(h, 'HighScore') : null;
    found = v ? 'present' : 'MISSING';
  } catch { found = 'lookup-failed'; }
  console.log(`  Reopened -> registry HighScore = ${found}  ${found === 'present' ? 'PASS ✅' : 'FAIL ❌ (regFlushTimer cleared on cleanup)'}`);
}

process.exit(0);
