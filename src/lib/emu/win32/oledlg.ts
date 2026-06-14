import type { Emulator } from '../emulator';

// OLEDLG.DLL stubs. Wine spec (dlls/oledlg/oledlg.spec) defines these by ordinal:
//   2  OleUIAddVerbMenuA
//   3  OleUIBusyA
//   4  OleUICanConvertOrActivateAs
//   5  OleUIChangeIconA
//   6  OleUIChangeSourceA
//   7  OleUIConvertA
//   8  OleUIEditLinksA
//   9  OleUIInsertObjectA
//  10  OleUIObjectPropertiesA
//  11  OleUIPasteSpecialA
//  12  OleUIPromptUserA / OleUIUpdateLinksA
// Each takes a single LPSTRUCT argument (4 bytes) and returns OLEUI_FALSE (0)
// to indicate the user cancelled the dialog — safe stub for headless runs.
export function registerOledlg(emu: Emulator): void {
  const oledlg = emu.registerDll('OLEDLG.DLL');

  const cancel = () => 0; // OLEUI_FALSE / IDCANCEL

  oledlg.register('OleUIAddVerbMenuA', 8, cancel);
  oledlg.register('OleUIAddVerbMenuW', 8, cancel);
  oledlg.register('OleUIBusyA', 1, cancel);
  oledlg.register('OleUIBusyW', 1, cancel);
  oledlg.register('OleUICanConvertOrActivateAs', 3, () => 0);
  oledlg.register('OleUIChangeIconA', 1, cancel);
  oledlg.register('OleUIChangeIconW', 1, cancel);
  oledlg.register('OleUIChangeSourceA', 1, cancel);
  oledlg.register('OleUIChangeSourceW', 1, cancel);
  oledlg.register('OleUIConvertA', 1, cancel);
  oledlg.register('OleUIConvertW', 1, cancel);
  oledlg.register('OleUIEditLinksA', 1, cancel);
  oledlg.register('OleUIEditLinksW', 1, cancel);
  oledlg.register('OleUIInsertObjectA', 1, cancel);
  oledlg.register('OleUIInsertObjectW', 1, cancel);
  oledlg.register('OleUIObjectPropertiesA', 1, cancel);
  oledlg.register('OleUIObjectPropertiesW', 1, cancel);
  oledlg.register('OleUIPasteSpecialA', 1, cancel);
  oledlg.register('OleUIPasteSpecialW', 1, cancel);
  oledlg.register('OleUIPromptUserA', 2, cancel);
  oledlg.register('OleUIPromptUserW', 2, cancel);
  oledlg.register('OleUIUpdateLinksA', 4, () => 0);
  oledlg.register('OleUIUpdateLinksW', 4, () => 0);
}
