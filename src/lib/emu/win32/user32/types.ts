export interface WndClassInfo {
  style: number;
  wndProc: number;
  rawWndProc?: number;
  cbClsExtra: number;
  cbWndExtra: number;
  hInstance: number;
  hIcon: number;
  hCursor: number;
  hbrBackground: number;
  menuName: number;
  className: string;
  /** For superclassed controls: the base built-in class name (e.g. "EDIT" for Delphi's "TEdit") */
  baseClassName?: string;
}

export interface WindowInfo {
  hwnd: number;
  classInfo: WndClassInfo;
  wndProc: number;
  rawWndProc?: number;
  parent: number;
  x: number;
  y: number;
  width: number;
  height: number;
  style: number;
  exStyle: number;
  title: string;
  visible: boolean;
  hMenu: number;
  extraBytes: Uint8Array;
  userData: number;
  children?: Map<number, number>;
  childList?: number[];  // ordered list of child hwnds for GetWindow(GW_CHILD/GW_HWNDNEXT)
  dlgProc?: number;
  controlId?: number;
  needsPaint?: boolean;
  _ownerDrawPending?: boolean;
  _odsSelected?: boolean;
  needsErase?: boolean;
  painting?: boolean;
  // Set when a synthesized WM_PAINT for the current invalidation was handed to
  // the app (GetMessage / PeekMessage PM_REMOVE). If it comes back to
  // synthesizePaint still set, the app processed the message without
  // BeginPaint/ValidateRect — validate then, so the paint is delivered exactly
  // once per invalidation instead of looping forever.
  _paintSynthesized?: boolean;
  // Client-area inset (margins from each window edge) reserved by the window's
  // own WM_NCCALCSIZE handler, captured by computeNcInset. Set ONLY for windows
  // that actually shrink the proposed rect (custom non-client areas — e.g. MFC
  // CSizingControlBar grippers/edges); undefined for everything else, which
  // falls back to the style-based getClientSize. Used by GetClientRect, the
  // WM_SIZE client dimensions, and child-origin offset.
  ncInset?: { l: number; t: number; r: number; b: number };
  // Accumulated invalid (dirty) region in client/device coords, unioned across
  // InvalidateRect calls. Captured into `paintRect` at BeginPaint so GetClipBox
  // can report the real update region instead of the whole window — apps that
  // size their paint from GetClipBox (e.g. MFC CScrollView views) otherwise
  // repaint everything on every tiny invalidation, which can saturate the CPU.
  invalidRect?: { l: number; t: number; r: number; b: number };
  paintRect?: { l: number; t: number; r: number; b: number };
  minimized?: boolean;
  maximized?: boolean;
  _preMaxRect?: { x: number; y: number; w: number; h: number };
  _preMinRect?: { x: number; y: number; w: number; h: number };
  checked?: number;   // BST_UNCHECKED=0, BST_CHECKED=1, BST_INDETERMINATE=2
  hFont?: number;     // font handle set via WM_SETFONT
  props?: Map<string, number>;  // window properties (SetProp/GetProp)
  trackPos?: number;    // trackbar position
  trackMin?: number;    // trackbar range min
  trackMax?: number;    // trackbar range max
  // TreeView state
  treeItems?: Map<number, TreeViewItem>;
  treeNextId?: number;
  treeSelectedItem?: number;
  treeImageList?: number;  // HIMAGELIST handle
  // ListBox state
  lbItems?: string[];
  lbItemData?: number[];
  lbSelectedIndex?: number;       // single-select: current selection (-1 = none)
  lbSelectedIndices?: Set<number>; // multi-select: set of selected indices
  lbTopIndex?: number;             // first visible item index
  lbItemHeight?: number;           // item height in pixels
  cbItemHeight?: number;           // combobox item height (Win16 CB_SETITEMHEIGHT)
  // ListView state
  listColumns?: ListViewColumn[];
  listItems?: ListViewItem[];
  // TabControl state
  tabItems?: { text: string }[];
  tabSelectedIndex?: number;
  /** TCM_SETIMAGELIST handle, returned again by TCM_GETIMAGELIST. */
  tabImageList?: number;
  // StatusBar state
  statusParts?: number[];
  statusTexts?: string[];
  // Toolbar button checked state (command IDs of checked buttons)
  toolbarChecked?: Set<number>;
  // Toolbar button list (TB_ADDBUTTONS) + bitmap (TB_ADDBITMAP / LoadToolBar)
  tbButtons?: Array<{ iBitmap: number; idCommand: number; fsState: number; fsStyle: number }>;
  tbButtonStructSize?: number;
  tbButtonSize?: number;     // MAKELONG(cy, cx) packed; canvas paint reads via & 0xFFFF / >> 16
  tbBitmapSize?: number;     // MAKELONG(cy, cx)
  tbBitmapHandle?: number;   // HBITMAP from TB_ADDBITMAP (TBADDBITMAP.nID when hInst=NULL)
  // ComboBox state
  cbItems?: string[];
  cbItemData?: number[];
  cbSelectedIndex?: number;
  // Min track size from WM_GETMINMAXINFO
  minTrackWidth?: number;
  minTrackHeight?: number;
  // Scroll bar state (mirrored from scroll.ts) so the non-client scrollbar can
  // be rendered. nBar SB_HORZ=0 -> scrollH, SB_VERT=1 -> scrollV.
  scrollH?: { nMin: number; nMax: number; nPage: number; nPos: number };
  scrollV?: { nMin: number; nMax: number; nPage: number; nPos: number };
  // Cached heap buffers for LVM_REDRAWITEMS
  _redrawNm?: number;
  _redrawTextBuf?: number;
  // Static control image handle (STM_SETIMAGE)
  hImage?: number;
  // Edit control state
  editSelStart?: number;
  editSelEnd?: number;
  editLimit?: number;     // EM_LIMITTEXT limit (0 = default 30000/32KB)
  editModified?: boolean; // EM_SETMODIFY / EM_GETMODIFY
  editBufferHandle?: number; // EM_GETHANDLE local heap handle
  ownerThreadId?: number; // thread that created this window
  /** Nesting counter to limit recursive WM_SIZE during MoveWindow/SetWindowPos */
  _wmSizeNest?: number;
  /** Per-control canvas for custom drawing (overlay companion canvas) */
  domCanvas?: HTMLCanvasElement;
  /** DOM input/textarea element for EDIT controls (clipboard operations) */
  domInput?: HTMLTextAreaElement | HTMLInputElement;
  // Scroll bar state (SB_HORZ=0, SB_VERT=1)
  scrollInfo?: { min: number; max: number; pos: number; page: number }[];
}

export interface TreeViewItem {
  id: number;
  parent: number;   // HTREEITEM of parent (0 = root)
  text: string;
  children: number[]; // child HTREEITEM ids
  expanded?: boolean;
  imageIndex?: number;
  selectedImageIndex?: number;
  lParam?: number;
}

export interface ListViewColumn {
  text: string;
  width: number;
  fmt: number;   // alignment
}

export interface ListViewItem {
  text: string;
  subItems?: string[];
  imageIndex?: number;
  lParam?: number;
  state?: number;  // LVIS_SELECTED=1, LVIS_FOCUSED=2, etc.
}
