export interface SectionHeader {
  name: string;
  virtualSize: number;
  virtualAddress: number;
  sizeOfRawData: number;
  pointerToRawData: number;
  characteristics: number;
}

export interface DataDirectory {
  virtualAddress: number;
  size: number;
}

export interface COFFHeader {
  machine: number;
  numberOfSections: number;
  timeDateStamp: number;
  sizeOfOptionalHeader: number;
  characteristics: number;
}

export interface ResourceLanguage {
  languageId: number;
  dataRva: number;
  dataSize: number;
  codePage: number;
}

export interface ResourceEntry {
  id: number | null;
  name: string | null;
  languages: ResourceLanguage[];
}

export interface ResourceType {
  typeId: number | null;
  typeName: string | null;
  typeLabel: string;
  entries: ResourceEntry[];
}

export interface MZHeader {
  e_cblp: number;
  e_cp: number;
  e_crlc: number;
  e_cparhdr: number;
  e_minalloc: number;
  e_maxalloc: number;
  e_ss: number;
  e_sp: number;
  e_ip: number;
  e_cs: number;
  e_lfarlc: number;
  e_ovno: number;
}

export interface PEInfo {
  dosHeader: { e_magic: number; e_lfanew: number };
  coffHeader: COFFHeader;
  optionalHeader: { magic: number; isPE32Plus: boolean; subsystem: number; dataDirectories: DataDirectory[] };
  sections: SectionHeader[];
  resources: ResourceType[] | null;
  isNE?: boolean;
  neEncoding?: string;
  isMZ?: boolean;
  mzHeader?: MZHeader;
  isCOM?: boolean;
  /** Set when section names indicate UPX packing (UPX0/UPX1 or similar).
   *  Resources, imports, and code are not yet present on disk — they exist
   *  only after the runtime decompression stub finishes executing. */
  isUpxPacked?: boolean;
}

export interface BitmapResult {
  id: number | null;
  name: string | null;
  languageId: number;
  bmpBlob: Blob;
  width: number;
  height: number;
  bitCount: number;
  magentaIndex: number;
  dibData: Uint8Array | null;
}

export interface StringResult {
  id: number;
  string: string;
  languageId: number;
}

export interface ManifestResult {
  id: number | null;
  name: string | null;
  languageId: number;
  text: string;
}

export interface VersionFixedInfo {
  fileVersion: string;
  productVersion: string;
}

export interface VersionResult {
  id: number | null;
  name: string | null;
  languageId: number;
  fixedInfo: VersionFixedInfo | null;
  strings: Record<string, string>;
}

export interface DfmComponent {
  className: string;
  name: string;
  properties: Record<string, unknown>;
  children: DfmComponent[];
}

export interface DfmResult {
  id: number | null;
  name: string | null;
  languageId: number;
  form: DfmComponent;
}

export interface MenuItem {
  id: number;
  text: string;
  isSeparator: boolean;
  isChecked: boolean;
  isGrayed: boolean;
  isDefault: boolean;
  children: MenuItem[] | null;
}

export interface MenuTemplate {
  isExtended: boolean;
  items: MenuItem[];
}

export interface MenuResult {
  id: number | null;
  name: string | null;
  languageId: number;
  menu: MenuTemplate;
}

export interface DialogItem {
  style: number;
  exStyle: number;
  x: number;
  y: number;
  cx: number;
  cy: number;
  id: number;
  className: string;
  text: string;
  titleOrdinal: number | null;
}

export interface DialogFont {
  pointSize: number;
  weight?: number;
  italic?: boolean;
  typeface: string;
}

export interface DialogTemplate {
  style: number;
  exStyle: number;
  x: number;
  y: number;
  cx: number;
  cy: number;
  title: string;
  className: string | null;
  menuName: string | null;
  font: DialogFont | null;
  items: DialogItem[];
}

export interface DialogResult {
  id: number | null;
  name: string | null;
  languageId: number;
  dialog: DialogTemplate;
}

export interface IconVariant {
  width: number;
  height: number;
  bitCount: number;
}

export interface IconResult {
  id: number | null;
  name: string | null;
  blob: Blob;
  variants: IconVariant[];
}

export interface CursorVariant {
  width: number;
  height: number;
  hotspotX: number;
  hotspotY: number;
}

export interface CursorResult {
  id: number | null;
  name: string | null;
  blob: Blob;
  variants: CursorVariant[];
}

export interface AccelEntry {
  fVirt: number;
  key: number;
  cmd: number;
  keyName: string;
}

export interface AccelResult {
  id: number | null;
  name: string | null;
  entries: AccelEntry[];
}

export interface AviResult {
  id: number | null;
  name: string | null;
  blob: Blob;
  rawData: Uint8Array;
}

export interface WavResult {
  id: number | null;
  name: string | null;
  blob: Blob;
}

export interface BmpFileResult {
  blob: Blob;
  width: number;
  height: number;
  bitCount: number;
  magentaIndex: number;
}

export interface ImportFunction {
  name: string | null;
  ordinal: number | null;
  hint: number;
}

export interface ImportResult {
  dll: string;
  functions: ImportFunction[];
}

export interface ExportFunction {
  ordinal: number;
  name: string | null;
  rva: number;
  forwardedTo: string | null;
}

export interface ExportResult {
  dll: string;
  functions: ExportFunction[];
}

export interface ResourceDirEntry {
  id: number | null;
  name: string | null;
  children?: ResourceDirEntry[];
  dataRva?: number;
  dataSize?: number;
  codePage?: number;
}
