import type { Emulator } from '../../emulator';
import type { WindowInfo } from './types';
import {
  MF_BYPOSITION, MF_CHECKED, MF_GRAYED, MF_DISABLED, MF_SEPARATOR,
  MF_POPUP, MF_STRING, MF_BITMAP, MF_OWNERDRAW,
  MIIM_STATE, MIIM_ID, MIIM_SUBMENU, MIIM_TYPE, MIIM_DATA, MIIM_STRING,
  MIIM_FTYPE, MIIM_BITMAP,
  MFT_SEPARATOR, MFT_STRING,
  MFS_GRAYED, MFS_CHECKED, MFS_DEFAULT,
} from '../types';

/** In-memory menu item for dynamically created/modified menus */
export interface InternalMenuItem {
  id: number;          // wID (command identifier)
  text: string;        // item text
  flags: number;       // MF_* combined flags
  hSubMenu: number;    // submenu handle (0 = none)
  itemData: number;    // dwItemData
  hBmpItem: number;    // hbmpItem
}

/** Menu data stored in handle table */
export interface MenuData {
  menuId?: number | string;  // resource ID (for LoadMenu)
  items: InternalMenuItem[];
}

function getMenuData(emu: Emulator, hMenu: number): MenuData | null {
  return emu.handles.get<MenuData>(hMenu);
}

function findItemIndex(menu: MenuData, uItem: number, byPosition: boolean): number {
  if (byPosition) return uItem < menu.items.length ? uItem : -1;
  return menu.items.findIndex(it => it.id === uItem);
}

function menuFlagsToState(item: InternalMenuItem): number {
  let state = 0;
  if (item.flags & MF_CHECKED) state |= MFS_CHECKED;
  if (item.flags & (MF_GRAYED | MF_DISABLED)) state |= MFS_GRAYED;
  return state;
}

function menuFlagsToType(item: InternalMenuItem): number {
  let type = 0;
  if (item.flags & MF_SEPARATOR) type |= MFT_SEPARATOR;
  if (item.flags & MF_OWNERDRAW) type |= 0x100; // MFT_OWNERDRAW
  if (item.flags & MF_BITMAP) type |= 0x4;      // MFT_BITMAP
  return type;
}

export function registerMenu(emu: Emulator): void {
  const user32 = emu.registerDll('USER32.DLL');

  // --- Create / Destroy ---

  user32.register('CreateMenu', 0, () => {
    return emu.handles.alloc('menu', { items: [] } as MenuData);
  });

  user32.register('CreatePopupMenu', 0, () => {
    return emu.handles.alloc('menu', { items: [] } as MenuData);
  });

  user32.register('DestroyMenu', 1, () => {
    const hMenu = emu.readArg(0);
    const menu = getMenuData(emu, hMenu);
    if (!menu) return 0;
    // Recursively destroy submenus
    for (const item of menu.items) {
      if (item.hSubMenu) {
        emu.handles.free(item.hSubMenu);
      }
    }
    emu.handles.free(hMenu);
    return 1;
  });

  // --- Load from resource ---

  user32.register('LoadMenuA', 2, () => {
    const _hInstance = emu.readArg(0);
    const menuNamePtr = emu.readArg(1);
    let menuId: number | string;
    if (menuNamePtr < 0x10000) {
      menuId = menuNamePtr;
    } else {
      menuId = emu.memory.readCString(menuNamePtr);
    }
    return emu.handles.alloc('menu', { menuId, items: [] } as MenuData);
  });

  user32.register('LoadMenuW', 2, () => {
    const _hInstance = emu.readArg(0);
    const menuNamePtr = emu.readArg(1);
    let menuId: number | string;
    if (menuNamePtr < 0x10000) {
      menuId = menuNamePtr;
    } else {
      menuId = emu.memory.readUTF16String(menuNamePtr);
    }
    return emu.handles.alloc('menu', { menuId, items: [] } as MenuData);
  });

  // --- Set / Get window menu ---

  user32.register('SetMenu', 2, () => {
    const hwnd = emu.readArg(0);
    const hMenu = emu.readArg(1);
    const wnd = emu.handles.get<WindowInfo>(hwnd);
    if (wnd) wnd.hMenu = hMenu;
    // Programs that build their menu at runtime (CreateMenu + AppendMenu, no
    // RT_MENU resource) only become visible after SetMenu attaches the tree
    // to a window. Notify the UI so it can re-read the runtime structure.
    emu.onSetMenu?.(hwnd, hMenu);
    return 1;
  });

  user32.register('GetMenu', 1, () => {
    const hwnd = emu.readArg(0);
    const wnd = emu.handles.get<WindowInfo>(hwnd);
    return wnd?.hMenu || 0;
  });

  user32.register('DrawMenuBar', 1, () => 1);

  user32.register('GetSystemMenu', 2, () => {
    // Return a pseudo system menu handle
    return emu.handles.alloc('menu', { items: [] } as MenuData);
  });

  // --- Append / Insert / Modify (classic UINT-based) ---

  user32.register('AppendMenuA', 4, () => {
    const hMenu = emu.readArg(0);
    const uFlags = emu.readArg(1);
    const uIDNewItem = emu.readArg(2);
    const lpNewItem = emu.readArg(3);
    const menu = getMenuData(emu, hMenu);
    if (!menu) return 0;
    const item: InternalMenuItem = {
      id: uIDNewItem,
      text: '',
      flags: uFlags,
      hSubMenu: (uFlags & MF_POPUP) ? uIDNewItem : 0,
      itemData: 0,
      hBmpItem: 0,
    };
    if (!(uFlags & (MF_SEPARATOR | MF_BITMAP | MF_OWNERDRAW)) && lpNewItem) {
      item.text = emu.memory.readCString(lpNewItem);
    }
    menu.items.push(item);
    return 1;
  });

  user32.register('AppendMenuW', 4, () => {
    const hMenu = emu.readArg(0);
    const uFlags = emu.readArg(1);
    const uIDNewItem = emu.readArg(2);
    const lpNewItem = emu.readArg(3);
    const menu = getMenuData(emu, hMenu);
    if (!menu) return 0;
    const item: InternalMenuItem = {
      id: uIDNewItem,
      text: '',
      flags: uFlags,
      hSubMenu: (uFlags & MF_POPUP) ? uIDNewItem : 0,
      itemData: 0,
      hBmpItem: 0,
    };
    if (!(uFlags & (MF_SEPARATOR | MF_BITMAP | MF_OWNERDRAW)) && lpNewItem) {
      item.text = emu.memory.readUTF16String(lpNewItem);
    }
    menu.items.push(item);
    return 1;
  });

  user32.register('InsertMenuA', 5, () => {
    const hMenu = emu.readArg(0);
    const uPosition = emu.readArg(1);
    const uFlags = emu.readArg(2);
    const uIDNewItem = emu.readArg(3);
    const lpNewItem = emu.readArg(4);
    const menu = getMenuData(emu, hMenu);
    if (!menu) return 0;
    const item: InternalMenuItem = {
      id: uIDNewItem,
      text: '',
      flags: uFlags,
      hSubMenu: (uFlags & MF_POPUP) ? uIDNewItem : 0,
      itemData: 0,
      hBmpItem: 0,
    };
    if (!(uFlags & (MF_SEPARATOR | MF_BITMAP | MF_OWNERDRAW)) && lpNewItem) {
      item.text = emu.memory.readCString(lpNewItem);
    }
    const byPos = !!(uFlags & MF_BYPOSITION);
    const idx = byPos ? uPosition : menu.items.findIndex(it => it.id === uPosition);
    if (idx >= 0 && idx <= menu.items.length) {
      menu.items.splice(idx, 0, item);
    } else {
      menu.items.push(item); // append if position not found
    }
    return 1;
  });

  user32.register('InsertMenuW', 5, () => {
    const hMenu = emu.readArg(0);
    const uPosition = emu.readArg(1);
    const uFlags = emu.readArg(2);
    const uIDNewItem = emu.readArg(3);
    const lpNewItem = emu.readArg(4);
    const menu = getMenuData(emu, hMenu);
    if (!menu) return 0;
    const item: InternalMenuItem = {
      id: uIDNewItem,
      text: '',
      flags: uFlags,
      hSubMenu: (uFlags & MF_POPUP) ? uIDNewItem : 0,
      itemData: 0,
      hBmpItem: 0,
    };
    if (!(uFlags & (MF_SEPARATOR | MF_BITMAP | MF_OWNERDRAW)) && lpNewItem) {
      item.text = emu.memory.readUTF16String(lpNewItem);
    }
    const byPos = !!(uFlags & MF_BYPOSITION);
    const idx = byPos ? uPosition : menu.items.findIndex(it => it.id === uPosition);
    if (idx >= 0 && idx <= menu.items.length) {
      menu.items.splice(idx, 0, item);
    } else {
      menu.items.push(item);
    }
    return 1;
  });

  user32.register('ModifyMenuA', 5, () => {
    const hMenu = emu.readArg(0);
    const uPosition = emu.readArg(1);
    const uFlags = emu.readArg(2);
    const uIDNewItem = emu.readArg(3);
    const lpNewItem = emu.readArg(4);
    const menu = getMenuData(emu, hMenu);
    if (!menu) return 0;
    const byPos = !!(uFlags & MF_BYPOSITION);
    const idx = findItemIndex(menu, uPosition, byPos);
    if (idx < 0) return 0;
    const item = menu.items[idx];
    item.id = uIDNewItem;
    item.flags = uFlags;
    item.hSubMenu = (uFlags & MF_POPUP) ? uIDNewItem : 0;
    if (!(uFlags & (MF_SEPARATOR | MF_BITMAP | MF_OWNERDRAW)) && lpNewItem) {
      item.text = emu.memory.readCString(lpNewItem);
    }
    return 1;
  });

  user32.register('ModifyMenuW', 5, () => {
    const hMenu = emu.readArg(0);
    const uPosition = emu.readArg(1);
    const uFlags = emu.readArg(2);
    const uIDNewItem = emu.readArg(3);
    const lpNewItem = emu.readArg(4);
    const menu = getMenuData(emu, hMenu);
    if (!menu) return 0;
    const byPos = !!(uFlags & MF_BYPOSITION);
    const idx = findItemIndex(menu, uPosition, byPos);
    if (idx < 0) return 0;
    const item = menu.items[idx];
    item.id = uIDNewItem;
    item.flags = uFlags;
    item.hSubMenu = (uFlags & MF_POPUP) ? uIDNewItem : 0;
    if (!(uFlags & (MF_SEPARATOR | MF_BITMAP | MF_OWNERDRAW)) && lpNewItem) {
      item.text = emu.memory.readUTF16String(lpNewItem);
    }
    return 1;
  });

  // --- Delete / Remove ---

  user32.register('DeleteMenu', 3, () => {
    const hMenu = emu.readArg(0);
    const uPosition = emu.readArg(1);
    const uFlags = emu.readArg(2);
    const menu = getMenuData(emu, hMenu);
    if (!menu) return 0;
    const byPos = !!(uFlags & MF_BYPOSITION);
    const idx = findItemIndex(menu, uPosition, byPos);
    if (idx < 0) return 0;
    const removed = menu.items.splice(idx, 1)[0];
    // DeleteMenu destroys submenus
    if (removed.hSubMenu) {
      emu.handles.free(removed.hSubMenu);
    }
    return 1;
  });

  user32.register('RemoveMenu', 3, () => {
    const hMenu = emu.readArg(0);
    const uPosition = emu.readArg(1);
    const uFlags = emu.readArg(2);
    const menu = getMenuData(emu, hMenu);
    if (!menu) return 0;
    const byPos = !!(uFlags & MF_BYPOSITION);
    const idx = findItemIndex(menu, uPosition, byPos);
    if (idx < 0) return 0;
    menu.items.splice(idx, 1);
    // RemoveMenu does NOT destroy submenus
    return 1;
  });

  // --- Query ---

  user32.register('GetMenuItemCount', 1, () => {
    const hMenu = emu.readArg(0);
    const menu = getMenuData(emu, hMenu);
    if (!menu) return -1; // 0xFFFFFFFF
    return menu.items.length;
  });

  user32.register('GetMenuItemID', 2, () => {
    const hMenu = emu.readArg(0);
    const nPos = emu.readArg(1);
    const menu = getMenuData(emu, hMenu);
    if (!menu || nPos >= menu.items.length) return 0xFFFFFFFF;
    const item = menu.items[nPos];
    if (item.hSubMenu) return 0xFFFFFFFF; // popup items return -1
    return item.id;
  });

  user32.register('GetSubMenu', 2, () => {
    const hMenu = emu.readArg(0);
    const nPos = emu.readArg(1);
    const menu = getMenuData(emu, hMenu);
    if (!menu || nPos >= menu.items.length) return 0;
    return menu.items[nPos].hSubMenu || 0;
  });

  user32.register('GetMenuState', 3, () => {
    const hMenu = emu.readArg(0);
    const uId = emu.readArg(1);
    const uFlags = emu.readArg(2);
    const menu = getMenuData(emu, hMenu);
    if (!menu) return 0xFFFFFFFF;
    const byPos = !!(uFlags & MF_BYPOSITION);
    const idx = findItemIndex(menu, uId, byPos);
    if (idx < 0) return 0xFFFFFFFF;
    const item = menu.items[idx];
    let state = item.flags & (MF_CHECKED | MF_GRAYED | MF_DISABLED | MF_SEPARATOR);
    if (item.hSubMenu) {
      // For popup items, high byte = item count in submenu
      const sub = getMenuData(emu, item.hSubMenu);
      state |= MF_POPUP;
      if (sub) state |= (sub.items.length << 8);
    }
    return state;
  });

  user32.register('GetMenuStringA', 5, () => {
    const hMenu = emu.readArg(0);
    const uIDItem = emu.readArg(1);
    const lpString = emu.readArg(2);
    const cchMax = emu.readArg(3);
    const uFlags = emu.readArg(4);
    const menu = getMenuData(emu, hMenu);
    if (!menu) return 0;
    const byPos = !!(uFlags & MF_BYPOSITION);
    const idx = findItemIndex(menu, uIDItem, byPos);
    if (idx < 0) return 0;
    const text = menu.items[idx].text;
    if (lpString && cchMax > 0) {
      const bytes = new TextEncoder().encode(text);
      const len = Math.min(bytes.length, cchMax - 1);
      for (let i = 0; i < len; i++) emu.memory.writeU8(lpString + i, bytes[i]);
      emu.memory.writeU8(lpString + len, 0);
      return len;
    }
    return text.length;
  });

  user32.register('GetMenuStringW', 5, () => {
    const hMenu = emu.readArg(0);
    const uIDItem = emu.readArg(1);
    const lpString = emu.readArg(2);
    const cchMax = emu.readArg(3);
    const uFlags = emu.readArg(4);
    const menu = getMenuData(emu, hMenu);
    if (!menu) return 0;
    const byPos = !!(uFlags & MF_BYPOSITION);
    const idx = findItemIndex(menu, uIDItem, byPos);
    if (idx < 0) return 0;
    const text = menu.items[idx].text;
    if (lpString && cchMax > 0) {
      const len = Math.min(text.length, cchMax - 1);
      for (let i = 0; i < len; i++) emu.memory.writeU16(lpString + i * 2, text.charCodeAt(i));
      emu.memory.writeU16(lpString + len * 2, 0);
      return len;
    }
    return text.length;
  });

  // --- Check / Enable ---

  user32.register('CheckMenuItem', 3, () => {
    const hMenu = emu.readArg(0);
    const uIDCheckItem = emu.readArg(1);
    const uCheck = emu.readArg(2);
    // Try internal menu data first
    const menu = getMenuData(emu, hMenu);
    if (menu) {
      const byPos = !!(uCheck & MF_BYPOSITION);
      const idx = findItemIndex(menu, uIDCheckItem, byPos);
      if (idx < 0) return 0xFFFFFFFF;
      const item = menu.items[idx];
      const prev = (item.flags & MF_CHECKED) ? MF_CHECKED : 0;
      if (uCheck & MF_CHECKED) item.flags |= MF_CHECKED;
      else item.flags &= ~MF_CHECKED;
      // Sync to legacy menuItems (React UI) by the resolved item's COMMAND ID.
      // MF_BYPOSITION positions are relative to THIS submenu, not the flat
      // top-level legacy array, so a by-position lookup there hit the wrong
      // item (MFC's CCmdUI::SetCheck always uses MF_BYPOSITION).
      if (emu.menuItems && item.id) {
        const legacy = findLegacyById(emu.menuItems, item.id);
        if (legacy) legacy.isChecked = !!(uCheck & MF_CHECKED);
      }
      emu.onMenuChanged?.();
      return prev;
    }
    // Fallback to legacy emu.menuItems
    if (!emu.menuItems) return 0xFFFFFFFF;
    const byPos = !!(uCheck & MF_BYPOSITION);
    const found = byPos
      ? findLegacyByPos(emu.menuItems, uIDCheckItem)
      : findLegacyById(emu.menuItems, uIDCheckItem);
    if (!found) return 0xFFFFFFFF;
    const prev = found.isChecked ? MF_CHECKED : 0;
    found.isChecked = !!(uCheck & MF_CHECKED);
    emu.onMenuChanged?.();
    return prev;
  });

  user32.register('EnableMenuItem', 3, () => {
    const hMenu = emu.readArg(0);
    const uIDEnableItem = emu.readArg(1);
    const uEnable = emu.readArg(2);
    const menu = getMenuData(emu, hMenu);
    if (menu) {
      const byPos = !!(uEnable & MF_BYPOSITION);
      const idx = findItemIndex(menu, uIDEnableItem, byPos);
      if (idx < 0) return 0xFFFFFFFF;
      const item = menu.items[idx];
      const prev = (item.flags & (MF_GRAYED | MF_DISABLED)) ? MF_GRAYED : 0;
      item.flags &= ~(MF_GRAYED | MF_DISABLED);
      item.flags |= (uEnable & (MF_GRAYED | MF_DISABLED));
      // Sync to legacy menuItems (React UI) by the resolved item's command id
      // (MF_BYPOSITION positions are submenu-relative — see CheckMenuItem).
      if (emu.menuItems && item.id) {
        const legacy = findLegacyById(emu.menuItems, item.id);
        if (legacy) legacy.isGrayed = !!(uEnable & (MF_GRAYED | MF_DISABLED));
      }
      emu.onMenuChanged?.();
      return prev;
    }
    if (!emu.menuItems) return 0xFFFFFFFF;
    const byPos = !!(uEnable & MF_BYPOSITION);
    const found = byPos
      ? findLegacyByPos(emu.menuItems, uIDEnableItem)
      : findLegacyById(emu.menuItems, uIDEnableItem);
    if (!found) return 0xFFFFFFFF;
    const prev = found.isGrayed ? MF_GRAYED : 0;
    found.isGrayed = !!(uEnable & (MF_GRAYED | MF_DISABLED));
    emu.onMenuChanged?.();
    return prev;
  });

  user32.register('CheckMenuRadioItem', 5, () => {
    const hMenu = emu.readArg(0);
    const idFirst = emu.readArg(1);
    const idLast = emu.readArg(2);
    const idCheck = emu.readArg(3);
    const uFlags = emu.readArg(4);
    const menu = getMenuData(emu, hMenu);
    if (menu) {
      const byPos = !!(uFlags & MF_BYPOSITION);
      for (let i = idFirst; i <= idLast; i++) {
        const idx = findItemIndex(menu, i, byPos);
        if (idx < 0) continue;
        const it = menu.items[idx];
        if (i === idCheck) it.flags |= MF_CHECKED;
        else it.flags &= ~MF_CHECKED;
        // Sync legacy by the resolved item's command id (positions are
        // submenu-relative — see CheckMenuItem).
        if (emu.menuItems && it.id) {
          const legacy = findLegacyById(emu.menuItems, it.id);
          if (legacy) legacy.isChecked = (i === idCheck);
        }
      }
      emu.onMenuChanged?.();
      return 1;
    }
    if (!emu.menuItems) return 1;
    const byPos = !!(uFlags & MF_BYPOSITION);
    for (let i = idFirst; i <= idLast; i++) {
      const found = byPos
        ? findLegacyByPos(emu.menuItems, i)
        : findLegacyById(emu.menuItems, i);
      if (found) found.isChecked = (i === idCheck);
    }
    emu.onMenuChanged?.();
    return 1;
  });

  // --- MENUITEMINFO-based APIs ---

  user32.register('InsertMenuItemA', 4, () => {
    const hMenu = emu.readArg(0);
    const uItem = emu.readArg(1);
    const fByPosition = emu.readArg(2);
    const lpmii = emu.readArg(3);
    const menu = getMenuData(emu, hMenu);
    if (!menu || !lpmii) return 0;
    const item = readMenuItemInfo(emu, lpmii, false);
    const idx = fByPosition ? Math.min(uItem, menu.items.length) : menu.items.findIndex(it => it.id === uItem);
    if (idx >= 0) menu.items.splice(idx, 0, item);
    else menu.items.push(item);
    return 1;
  });

  user32.register('InsertMenuItemW', 4, () => {
    const hMenu = emu.readArg(0);
    const uItem = emu.readArg(1);
    const fByPosition = emu.readArg(2);
    const lpmii = emu.readArg(3);
    const menu = getMenuData(emu, hMenu);
    if (!menu || !lpmii) return 0;
    const item = readMenuItemInfo(emu, lpmii, true);
    const idx = fByPosition ? Math.min(uItem, menu.items.length) : menu.items.findIndex(it => it.id === uItem);
    if (idx >= 0) menu.items.splice(idx, 0, item);
    else menu.items.push(item);
    return 1;
  });

  user32.register('SetMenuItemInfoA', 4, () => {
    const hMenu = emu.readArg(0);
    const uItem = emu.readArg(1);
    const fByPosition = emu.readArg(2);
    const lpmii = emu.readArg(3);
    const menu = getMenuData(emu, hMenu);
    if (!menu || !lpmii) return 0;
    const idx = fByPosition ? uItem : menu.items.findIndex(it => it.id === uItem);
    if (idx < 0 || idx >= menu.items.length) return 0;
    applyMenuItemInfo(emu, lpmii, menu.items[idx], false);
    return 1;
  });

  user32.register('SetMenuItemInfoW', 4, () => {
    const hMenu = emu.readArg(0);
    const uItem = emu.readArg(1);
    const fByPosition = emu.readArg(2);
    const lpmii = emu.readArg(3);
    const menu = getMenuData(emu, hMenu);
    if (!menu || !lpmii) return 0;
    const idx = fByPosition ? uItem : menu.items.findIndex(it => it.id === uItem);
    if (idx < 0 || idx >= menu.items.length) return 0;
    applyMenuItemInfo(emu, lpmii, menu.items[idx], true);
    return 1;
  });

  user32.register('GetMenuItemInfoA', 4, () => {
    const hMenu = emu.readArg(0);
    const uItem = emu.readArg(1);
    const fByPosition = emu.readArg(2);
    const lpmii = emu.readArg(3);
    const menu = getMenuData(emu, hMenu);
    if (!menu || !lpmii) return 0;
    const idx = fByPosition ? uItem : menu.items.findIndex(it => it.id === uItem);
    if (idx < 0 || idx >= menu.items.length) return 0;
    writeMenuItemInfo(emu, lpmii, menu.items[idx], false);
    return 1;
  });

  user32.register('GetMenuItemInfoW', 4, () => {
    const hMenu = emu.readArg(0);
    const uItem = emu.readArg(1);
    const fByPosition = emu.readArg(2);
    const lpmii = emu.readArg(3);
    const menu = getMenuData(emu, hMenu);
    if (!menu || !lpmii) return 0;
    const idx = fByPosition ? uItem : menu.items.findIndex(it => it.id === uItem);
    if (idx < 0 || idx >= menu.items.length) return 0;
    writeMenuItemInfo(emu, lpmii, menu.items[idx], true);
    return 1;
  });

  // --- Popup / Tracking ---

  user32.register('TrackPopupMenu', 7, () => 0);
  user32.register('TrackPopupMenuEx', 6, () => 0);

  // --- Misc ---

  user32.register('GetMenuItemRect', 4, () => {
    const rectPtr = emu.readArg(3);
    if (rectPtr) {
      emu.memory.writeU32(rectPtr, 0);
      emu.memory.writeU32(rectPtr + 4, 0);
      emu.memory.writeU32(rectPtr + 8, 100);
      emu.memory.writeU32(rectPtr + 12, 20);
    }
    return 1;
  });

  user32.register('SetMenuItemBitmaps', 5, () => 1);
  user32.register('IsMenu', 1, () => {
    const hMenu = emu.readArg(0);
    return getMenuData(emu, hMenu) ? 1 : 0;
  });

  user32.register('CopyAcceleratorTableW', 3, () => 0);
  user32.register('SetMenuDefaultItem', 3, () => {
    const hMenu = emu.readArg(0);
    const uItem = emu.readArg(1);
    const fByPos = emu.readArg(2);
    const menu = getMenuData(emu, hMenu);
    if (!menu) return 0;
    // Clear existing defaults, set new one
    for (const item of menu.items) item.flags &= ~0x1000;
    if (uItem !== 0xFFFFFFFF) {
      const idx = findItemIndex(menu, uItem, !!fByPos);
      if (idx >= 0) menu.items[idx].flags |= 0x1000;
    }
    return 1;
  });

  user32.register('GetMenuDefaultItem', 3, () => {
    const hMenu = emu.readArg(0);
    const fByPos = emu.readArg(1);
    const menu = getMenuData(emu, hMenu);
    if (!menu) return 0xFFFFFFFF;
    for (let i = 0; i < menu.items.length; i++) {
      if (menu.items[i].flags & 0x1000) return fByPos ? i : menu.items[i].id;
    }
    return 0xFFFFFFFF;
  });

  user32.register('HiliteMenuItem', 4, () => 1);
  user32.register('MenuItemFromPoint', 3, () => 0xFFFFFFFF);

  // EndMenu() → BOOL — cancels any active menu
  user32.register('EndMenu', 0, () => 1);
}

// --- MENUITEMINFO helpers ---
// MENUITEMINFO struct layout (48 bytes):
// 0: cbSize (4), 4: fMask (4), 8: fType (4), 12: fState (4),
// 16: wID (4), 20: hSubMenu (4), 24: hbmpChecked (4), 28: hbmpUnchecked (4),
// 32: dwItemData (4), 36: dwTypeData (4), 40: cch (4), 44: hbmpItem (4)

function readMenuItemInfo(emu: Emulator, ptr: number, wide: boolean): InternalMenuItem {
  const fMask = emu.memory.readU32(ptr + 4);
  const fType = emu.memory.readU32(ptr + 8);
  const fState = emu.memory.readU32(ptr + 12);
  const wID = emu.memory.readU32(ptr + 16);
  const hSubMenu = emu.memory.readU32(ptr + 20);
  const dwItemData = emu.memory.readU32(ptr + 32);
  const dwTypeData = emu.memory.readU32(ptr + 36);
  const hbmpItem = emu.memory.readU32(ptr + 44);

  let flags = 0;
  let text = '';

  if (fMask & MIIM_TYPE) {
    if (fType & MFT_SEPARATOR) flags |= MF_SEPARATOR;
  }
  if (fMask & MIIM_FTYPE) {
    if (fType & MFT_SEPARATOR) flags |= MF_SEPARATOR;
  }
  if (fMask & MIIM_STATE) {
    if (fState & MFS_GRAYED) flags |= MF_GRAYED;
    if (fState & MFS_CHECKED) flags |= MF_CHECKED;
  }
  if ((fMask & (MIIM_STRING | MIIM_TYPE)) && dwTypeData && !(fType & MFT_SEPARATOR)) {
    text = wide ? emu.memory.readUTF16String(dwTypeData) : emu.memory.readCString(dwTypeData);
  }
  if (fMask & MIIM_SUBMENU && hSubMenu) flags |= MF_POPUP;

  return {
    id: (fMask & MIIM_ID) ? wID : 0,
    text,
    flags,
    hSubMenu: (fMask & MIIM_SUBMENU) ? hSubMenu : 0,
    itemData: (fMask & MIIM_DATA) ? dwItemData : 0,
    hBmpItem: (fMask & MIIM_BITMAP) ? hbmpItem : 0,
  };
}

function applyMenuItemInfo(emu: Emulator, ptr: number, item: InternalMenuItem, wide: boolean): void {
  const fMask = emu.memory.readU32(ptr + 4);
  const fType = emu.memory.readU32(ptr + 8);
  const fState = emu.memory.readU32(ptr + 12);
  const dwTypeData = emu.memory.readU32(ptr + 36);

  if (fMask & MIIM_TYPE) {
    item.flags &= ~(MF_SEPARATOR | MF_BITMAP | MF_OWNERDRAW);
    if (fType & MFT_SEPARATOR) item.flags |= MF_SEPARATOR;
    if (dwTypeData && !(fType & MFT_SEPARATOR)) {
      item.text = wide ? emu.memory.readUTF16String(dwTypeData) : emu.memory.readCString(dwTypeData);
    }
  }
  if (fMask & MIIM_FTYPE) {
    item.flags &= ~(MF_SEPARATOR | MF_BITMAP | MF_OWNERDRAW);
    if (fType & MFT_SEPARATOR) item.flags |= MF_SEPARATOR;
  }
  if (fMask & MIIM_STRING) {
    if (dwTypeData) {
      item.text = wide ? emu.memory.readUTF16String(dwTypeData) : emu.memory.readCString(dwTypeData);
    }
  }
  if (fMask & MIIM_STATE) {
    item.flags &= ~(MF_GRAYED | MF_DISABLED | MF_CHECKED);
    if (fState & MFS_GRAYED) item.flags |= MF_GRAYED;
    if (fState & MFS_CHECKED) item.flags |= MF_CHECKED;
  }
  if (fMask & MIIM_ID) item.id = emu.memory.readU32(ptr + 16);
  if (fMask & MIIM_SUBMENU) {
    item.hSubMenu = emu.memory.readU32(ptr + 20);
    if (item.hSubMenu) item.flags |= MF_POPUP;
    else item.flags &= ~MF_POPUP;
  }
  if (fMask & MIIM_DATA) item.itemData = emu.memory.readU32(ptr + 32);
  if (fMask & MIIM_BITMAP) item.hBmpItem = emu.memory.readU32(ptr + 44);
}

function writeMenuItemInfo(emu: Emulator, ptr: number, item: InternalMenuItem, wide: boolean): void {
  const fMask = emu.memory.readU32(ptr + 4);

  if (fMask & MIIM_TYPE) {
    emu.memory.writeU32(ptr + 8, menuFlagsToType(item));
  }
  if (fMask & MIIM_FTYPE) {
    emu.memory.writeU32(ptr + 8, menuFlagsToType(item));
  }
  if (fMask & MIIM_STATE) {
    emu.memory.writeU32(ptr + 12, menuFlagsToState(item));
  }
  if (fMask & MIIM_ID) {
    emu.memory.writeU32(ptr + 16, item.id);
  }
  if (fMask & MIIM_SUBMENU) {
    emu.memory.writeU32(ptr + 20, item.hSubMenu);
  }
  if (fMask & MIIM_DATA) {
    emu.memory.writeU32(ptr + 32, item.itemData);
  }
  if (fMask & MIIM_BITMAP) {
    emu.memory.writeU32(ptr + 44, item.hBmpItem);
  }
  if (fMask & (MIIM_STRING | MIIM_TYPE)) {
    const bufPtr = emu.memory.readU32(ptr + 36);
    const cchMax = emu.memory.readU32(ptr + 40);
    if (bufPtr && cchMax > 0) {
      const text = item.text;
      if (wide) {
        const len = Math.min(text.length, cchMax - 1);
        for (let i = 0; i < len; i++) emu.memory.writeU16(bufPtr + i * 2, text.charCodeAt(i));
        emu.memory.writeU16(bufPtr + len * 2, 0);
        emu.memory.writeU32(ptr + 40, len);
      } else {
        const bytes = new TextEncoder().encode(text);
        const len = Math.min(bytes.length, cchMax - 1);
        for (let i = 0; i < len; i++) emu.memory.writeU8(bufPtr + i, bytes[i]);
        emu.memory.writeU8(bufPtr + len, 0);
        emu.memory.writeU32(ptr + 40, len);
      }
    } else {
      // No buffer — just return the string length
      emu.memory.writeU32(ptr + 40, item.text.length);
    }
  }
}

// --- Build handle tree from PE-extracted MenuItem[] ---

import type { MenuItem } from '../../../pe/types';

/**
 * Build a full menu handle hierarchy from PE-extracted MenuItem[].
 * Creates handles for the top-level menu bar and each popup submenu,
 * so that GetMenu/GetSubMenu/EnableMenuItem work correctly from x86 code.
 */
export function buildMenuHandleTree(emu: Emulator, items: MenuItem[]): number {
  function convertItems(peItems: MenuItem[]): InternalMenuItem[] {
    return peItems.map(item => {
      let hSubMenu = 0;
      if (item.children && item.children.length > 0) {
        const subData: MenuData = { items: convertItems(item.children) };
        hSubMenu = emu.handles.alloc('menu', subData);
      }
      let flags = 0;
      if (item.isSeparator) flags |= MF_SEPARATOR;
      if (item.isGrayed) flags |= MF_GRAYED;
      if (item.isChecked) flags |= MF_CHECKED;
      if (hSubMenu) flags |= MF_POPUP;
      return { id: item.id, text: item.text, flags, hSubMenu, itemData: 0, hBmpItem: 0 } as InternalMenuItem;
    });
  }
  const menuData: MenuData = { items: convertItems(items) };
  return emu.handles.alloc('menu', menuData);
}

// --- Legacy emu.menuItems helpers (for resource-loaded menus) ---

function findLegacyById(items: MenuItem[], id: number): MenuItem | null {
  for (const item of items) {
    if (item.id === id) return item;
    if (item.children) {
      const found = findLegacyById(item.children, id);
      if (found) return found;
    }
  }
  return null;
}

function findLegacyByPos(items: MenuItem[], pos: number): MenuItem | null {
  return pos < items.length ? items[pos] : null;
}
