// Win32 message constants
export const WM_NULL = 0x0000;
export const WM_CREATE = 0x0001;
export const WM_DESTROY = 0x0002;
export const WM_MOVE = 0x0003;
export const WM_SIZE = 0x0005;
export const WM_ACTIVATE = 0x0006;
export const WM_SETFOCUS = 0x0007;
export const WM_KILLFOCUS = 0x0008;
export const WM_ENABLE = 0x000A;
export const WM_SETTEXT = 0x000C;
export const WM_GETTEXT = 0x000D;
export const WM_GETTEXTLENGTH = 0x000E;
export const WM_PAINT = 0x000F;
export const WM_CLOSE = 0x0010;
export const WM_QUIT = 0x0012;
export const WM_ERASEBKGND = 0x0014;
export const WM_SHOWWINDOW = 0x0018;
export const WM_ACTIVATEAPP = 0x001C;
export const WM_SETCURSOR = 0x0020;
export const WM_GETMINMAXINFO = 0x0024;
export const WM_DRAWITEM = 0x002B;
export const WM_WINDOWPOSCHANGING = 0x0046;
export const WM_WINDOWPOSCHANGED = 0x0047;
export const WM_NOTIFY = 0x004E;
export const WM_NCCREATE = 0x0081;
export const WM_NCDESTROY = 0x0082;
export const WM_NCCALCSIZE = 0x0083;
export const WM_NCHITTEST = 0x0084;
export const WM_NCPAINT = 0x0085;
export const WM_NCACTIVATE = 0x0086;
export const WM_GETDLGCODE = 0x0087;
export const WM_KEYDOWN = 0x0100;
export const WM_KEYUP = 0x0101;
export const WM_CHAR = 0x0102;
export const WM_SYSKEYDOWN = 0x0104;
export const WM_SYSKEYUP = 0x0105;
export const WM_COMMAND = 0x0111;
export const WM_SYSCOMMAND = 0x0112;
export const WM_TIMER = 0x0113;
export const WM_HSCROLL = 0x0114;
export const WM_VSCROLL = 0x0115;
export const WM_INITMENU = 0x0116;
export const WM_INITMENUPOPUP = 0x0117;
export const WM_MENUSELECT = 0x011F;
export const WM_ENTERIDLE = 0x0121;
export const WM_CTLCOLOREDIT = 0x0133;
export const WM_CTLCOLORLISTBOX = 0x0134;
export const WM_CTLCOLORBTN = 0x0135;
export const WM_CTLCOLORDLG = 0x0136;
export const WM_CTLCOLORSCROLLBAR = 0x0137;
export const WM_CTLCOLORSTATIC = 0x0138;
export const WM_MOUSEMOVE = 0x0200;
export const WM_LBUTTONDOWN = 0x0201;
export const WM_LBUTTONUP = 0x0202;
export const WM_LBUTTONDBLCLK = 0x0203;
export const WM_RBUTTONDOWN = 0x0204;
export const WM_RBUTTONUP = 0x0205;
export const WM_RBUTTONDBLCLK = 0x0206;
export const WM_MBUTTONDOWN = 0x0207;
export const WM_MBUTTONUP = 0x0208;
export const WM_USER = 0x0400;

// Trackbar messages
export const TBM_GETPOS = 0x0400;
export const TBM_GETRANGEMIN = 0x0401;
export const TBM_GETRANGEMAX = 0x0402;
export const TBM_SETPOS = 0x0405;
export const TBM_SETRANGE = 0x0406;
export const TBM_SETRANGEMIN = 0x0407;
export const TBM_SETRANGEMAX = 0x0408;

// Window styles
export const WS_OVERLAPPED = 0x00000000;
export const WS_POPUP = 0x80000000;
export const WS_CHILD = 0x40000000;
export const WS_MINIMIZE = 0x20000000;
export const WS_VISIBLE = 0x10000000;
export const WS_DISABLED = 0x08000000;
export const WS_CLIPSIBLINGS = 0x04000000;
export const WS_CLIPCHILDREN = 0x02000000;
export const WS_MAXIMIZE = 0x01000000;
export const WS_CAPTION = 0x00C00000;
export const WS_BORDER = 0x00800000;
export const WS_DLGFRAME = 0x00400000;
export const WS_VSCROLL = 0x00200000;
export const WS_HSCROLL = 0x00100000;
export const WS_SYSMENU = 0x00080000;
export const WS_THICKFRAME = 0x00040000;
export const WS_MINIMIZEBOX = 0x00020000;
export const WS_MAXIMIZEBOX = 0x00010000;
export const WS_OVERLAPPEDWINDOW = WS_OVERLAPPED | WS_CAPTION | WS_SYSMENU | WS_THICKFRAME | WS_MINIMIZEBOX | WS_MAXIMIZEBOX;

// Extended window styles
export const WS_EX_CLIENTEDGE = 0x00000200;
export const WS_EX_STATICEDGE = 0x00020000;

// Class styles
export const CS_VREDRAW = 0x0001;
export const CS_HREDRAW = 0x0002;
export const CS_DBLCLKS = 0x0008;

// ShowWindow commands
export const SW_HIDE = 0;
export const SW_SHOWNORMAL = 1;
export const SW_SHOW = 5;

// LoadImage types
export const IMAGE_BITMAP = 0;
export const IMAGE_ICON = 1;
export const IMAGE_CURSOR = 2;

// Raster operations
export const SRCCOPY = 0x00CC0020;
export const SRCPAINT = 0x00EE0086;
export const SRCAND = 0x008800C6;
export const SRCINVERT = 0x00660046;
export const SRCERASE = 0x00440328;
export const NOTSRCCOPY = 0x00330008;
export const PATCOPY = 0x00F00021;
export const PATPAINT = 0x00FB0A09;
export const PATINVERT = 0x005A0049;
export const BLACKNESS = 0x00000042;
export const WHITENESS = 0x00FF0062;
export const DSNA = 0x00220326;      // dst = dst AND NOT src ("DSna")
export const PSDPXAX = 0x00B8074A;   // dst = pat XOR (dst AND (pat XOR src)) ("PSDPxax")

// System colors
export const COLOR_SCROLLBAR = 0;
export const COLOR_BACKGROUND = 1;
export const COLOR_ACTIVECAPTION = 2;
export const COLOR_INACTIVECAPTION = 3;
export const COLOR_MENU = 4;
export const COLOR_WINDOW = 5;
export const COLOR_WINDOWFRAME = 6;
export const COLOR_MENUTEXT = 7;
export const COLOR_WINDOWTEXT = 8;
export const COLOR_CAPTIONTEXT = 9;
export const COLOR_ACTIVEBORDER = 10;
export const COLOR_INACTIVEBORDER = 11;
export const COLOR_APPWORKSPACE = 12;
export const COLOR_HIGHLIGHT = 13;
export const COLOR_HIGHLIGHTTEXT = 14;
export const COLOR_BTNFACE = 15;
export const COLOR_BTNSHADOW = 16;
export const COLOR_GRAYTEXT = 17;
export const COLOR_BTNTEXT = 18;
export const COLOR_INACTIVECAPTIONTEXT = 19;
export const COLOR_BTNHIGHLIGHT = 20;
export const COLOR_3DDKSHADOW = 21;
export const COLOR_3DLIGHT = 22;
export const COLOR_INFOTEXT = 23;
export const COLOR_INFOBK = 24;

// System color values (Win2K classic theme)
// COLORREF values in BGR format (0x00BBGGRR) — Win2K default theme
export const SYS_COLORS: Record<number, number> = {
  [COLOR_SCROLLBAR]: 0xC8D0D4,     // RGB(212,208,200)
  [COLOR_BACKGROUND]: 0xA56E3A,    // RGB(58,110,165) — desktop
  [COLOR_ACTIVECAPTION]: 0x6A240A, // RGB(10,36,106) — title bar
  [COLOR_INACTIVECAPTION]: 0x808080,
  [COLOR_MENU]: 0xC8D0D4,
  [COLOR_WINDOW]: 0xFFFFFF,
  [COLOR_WINDOWFRAME]: 0x000000,
  [COLOR_MENUTEXT]: 0x000000,
  [COLOR_WINDOWTEXT]: 0x000000,
  [COLOR_CAPTIONTEXT]: 0xFFFFFF,
  [COLOR_ACTIVEBORDER]: 0xC8D0D4,
  [COLOR_INACTIVEBORDER]: 0xC8D0D4,
  [COLOR_APPWORKSPACE]: 0x808080,
  [COLOR_HIGHLIGHT]: 0x6A240A,     // RGB(10,36,106)
  [COLOR_HIGHLIGHTTEXT]: 0xFFFFFF,
  [COLOR_BTNFACE]: 0xC8D0D4,       // RGB(212,208,200)
  [COLOR_BTNSHADOW]: 0x808080,
  [COLOR_GRAYTEXT]: 0x808080,
  [COLOR_BTNTEXT]: 0x000000,
  [COLOR_INACTIVECAPTIONTEXT]: 0xC8D0D4,
  [COLOR_BTNHIGHLIGHT]: 0xFFFFFF,
  [COLOR_3DDKSHADOW]: 0x404040,
  [COLOR_3DLIGHT]: 0xC8D0D4,
  [COLOR_INFOTEXT]: 0x000000,
  [COLOR_INFOBK]: 0xE1FFFF,        // RGB(255,255,225) — tooltip bg
};

// Stock objects
export const WHITE_BRUSH = 0;
export const LTGRAY_BRUSH = 1;
export const GRAY_BRUSH = 2;
export const DKGRAY_BRUSH = 3;
export const BLACK_BRUSH = 4;
export const NULL_BRUSH = 5;
export const WHITE_PEN = 6;
export const BLACK_PEN = 7;
export const NULL_PEN = 8;
export const OEM_FIXED_FONT = 10;
export const ANSI_FIXED_FONT = 11;
export const ANSI_VAR_FONT = 12;
export const SYSTEM_FONT = 13;
export const DEVICE_DEFAULT_FONT = 14;
export const DEFAULT_PALETTE = 15;
export const SYSTEM_FIXED_FONT = 16;
export const DEFAULT_GUI_FONT = 17;

// System metrics
export const SM_CXSCREEN = 0;
export const SM_CYSCREEN = 1;
export const SM_CXFRAME = 32;
export const SM_CYFRAME = 33;
export const SM_CXEDGE = 45;
export const SM_CYEDGE = 46;
export const SM_CYMENU = 15;
export const SM_CYCAPTION = 4;
export const SM_CXBORDER = 5;
export const SM_CYBORDER = 6;
export const SM_CXFIXEDFRAME = 7;
export const SM_CYFIXEDFRAME = 8;
export const SM_CXSIZE = 30;
export const SM_CYSIZE = 31;
export const SM_XVIRTUALSCREEN = 76;
export const SM_YVIRTUALSCREEN = 77;
export const SM_CXVIRTUALSCREEN = 78;
export const SM_CYVIRTUALSCREEN = 79;

// Background modes
export const TRANSPARENT = 1;
export const OPAQUE = 2;

// Owner-draw constants (DRAWITEMSTRUCT)
export const ODT_BUTTON = 4;
export const ODA_DRAWENTIRE = 0x1;
export const ODA_SELECT = 0x2;
export const ODA_FOCUS = 0x4;
export const ODS_SELECTED = 0x0001;
export const ODS_DISABLED = 0x0004;

// MK flags for mouse messages
export const MK_LBUTTON = 0x0001;
export const MK_RBUTTON = 0x0002;
export const MK_MBUTTON = 0x0010;

// DrawText flags
export const DT_TOP = 0x00000000;
export const DT_LEFT = 0x00000000;
export const DT_CENTER = 0x00000001;
export const DT_RIGHT = 0x00000002;
export const DT_VCENTER = 0x00000004;
export const DT_BOTTOM = 0x00000008;
export const DT_SINGLELINE = 0x00000020;
export const DT_NOCLIP = 0x00000100;

// Pen styles
export const PS_SOLID = 0;
export const PS_DASH = 1;
export const PS_DOT = 2;
export const PS_NULL = 5;

// IDC_ cursors
export const IDC_ARROW = 32512;
export const IDC_IBEAM = 32513;
export const IDC_WAIT = 32514;
export const IDC_CROSS = 32515;
export const IDC_HAND = 32649;

// IDI_ icons
export const IDI_APPLICATION = 32512;
export const IDI_ERROR = 32513;
export const IDI_QUESTION = 32514;
export const IDI_WARNING = 32515;
export const IDI_INFORMATION = 32516;

// MessageBox flags
export const MB_OK = 0x00000000;
export const MB_OKCANCEL = 0x00000001;
export const MB_YESNO = 0x00000004;
export const MB_ICONERROR = 0x00000010;
export const MB_ICONQUESTION = 0x00000020;
export const MB_ICONWARNING = 0x00000030;
export const MB_ICONINFORMATION = 0x00000040;
export const IDOK = 1;
export const IDCANCEL = 2;
export const IDYES = 6;
export const IDNO = 7;

// HTCLIENT for WM_NCHITTEST
export const HTCLIENT = 1;

// GDI object types (for GetObjectA)
export const OBJ_BITMAP = 7;

// CBT hook codes (WH_CBT)
export const HCBT_CREATEWND = 3;

// Misc
export const CW_USEDEFAULT = 0x80000000;
export const HWND_DESKTOP = 0;
export const GWL_STYLE = -16;
export const GWL_EXSTYLE = -20;
export const GWLP_USERDATA = -21;
export const GWLP_WNDPROC = -4;

// Registry
export const ERROR_SUCCESS = 0;
export const ERROR_FILE_NOT_FOUND = 2;
export const ERROR_MORE_DATA = 234;
export const ERROR_NO_MORE_ITEMS = 259;
export const HKEY_CURRENT_USER = 0x80000001;

// Heap flags
export const HEAP_ZERO_MEMORY = 0x00000008;

// sizeof
export const SIZEOF_MSG = 28;
export const SIZEOF_RECT = 16;
export const SIZEOF_PAINTSTRUCT = 64;
export const SIZEOF_WNDCLASSA = 40;
export const SIZEOF_WNDCLASSEXA = 48;
export const SIZEOF_BITMAP = 24;

// Menu flags
export const MF_BYCOMMAND = 0x00000000;
export const MF_BYPOSITION = 0x00000400;
export const MF_CHECKED = 0x00000008;
export const MF_UNCHECKED = 0x00000000;
export const MF_ENABLED = 0x00000000;
export const MF_GRAYED = 0x00000001;
export const MF_DISABLED = 0x00000002;
export const MF_STRING = 0x00000000;
export const MF_BITMAP = 0x00000004;
export const MF_POPUP = 0x00000010;
export const MF_MENUBARBREAK = 0x00000020;
export const MF_MENUBREAK = 0x00000040;
export const MF_OWNERDRAW = 0x00000100;
export const MF_SEPARATOR = 0x00000800;

// MENUITEMINFO mask flags
export const MIIM_STATE = 0x00000001;
export const MIIM_ID = 0x00000002;
export const MIIM_SUBMENU = 0x00000004;
export const MIIM_CHECKMARKS = 0x00000008;
export const MIIM_TYPE = 0x00000010;
export const MIIM_DATA = 0x00000020;
export const MIIM_STRING = 0x00000040;
export const MIIM_BITMAP = 0x00000080;
export const MIIM_FTYPE = 0x00000100;

// MENUITEMINFO type flags
export const MFT_STRING = 0x00000000;
export const MFT_BITMAP = 0x00000004;
export const MFT_MENUBARBREAK = 0x00000020;
export const MFT_MENUBREAK = 0x00000040;
export const MFT_OWNERDRAW = 0x00000100;
export const MFT_SEPARATOR = 0x00000800;

// MENUITEMINFO state flags
export const MFS_ENABLED = 0x00000000;
export const MFS_GRAYED = 0x00000003;
export const MFS_DISABLED = 0x00000003;
export const MFS_CHECKED = 0x00000008;
export const MFS_DEFAULT = 0x00001000;

// MENUITEMINFO struct size
export const SIZEOF_MENUITEMINFO = 48;

// WM_NCHITTEST return values
export const HTNOWHERE = 0;
export const HTCAPTION_VAL = 2;
export const HTSYSMENU = 3;

// PM_NOREMOVE / PM_REMOVE
export const PM_NOREMOVE = 0x0000;
export const PM_REMOVE = 0x0001;

// SC_* for WM_SYSCOMMAND
export const SC_CLOSE = 0xF060;
export const SC_MINIMIZE = 0xF020;
export const SC_MAXIMIZE = 0xF030;
export const SC_RESTORE = 0xF120;

// WinMine specific
export const WA_INACTIVE = 0;

// DIB / BI constants
export const DIB_RGB_COLORS = 0;
export const BI_RGB = 0;
