import type { PEInfo, MZHeader, ResourceDirEntry, SectionHeader } from './types';
import { readUint16, readUint32, readAscii, readUtf16, rvaToFileOffset, RT_TYPES } from './read';

export function parseResourceDirectory(
  dv: DataView,
  rsrcBaseOffset: number,
  dirOffset: number,
  level: number,
  sections: SectionHeader[],
): ResourceDirEntry[] {
  const abs = rsrcBaseOffset + dirOffset;

  const numberOfNamedEntries = readUint16(dv, abs + 12);
  const numberOfIdEntries = readUint16(dv, abs + 14);
  const totalEntries = numberOfNamedEntries + numberOfIdEntries;

  const entries: ResourceDirEntry[] = [];
  for (let i = 0; i < totalEntries; i++) {
    const entryOffset = abs + 16 + i * 8;
    const nameOrId = readUint32(dv, entryOffset);
    const offsetToData = readUint32(dv, entryOffset + 4);

    let id: number | null = null;
    let name: string | null = null;

    if (nameOrId & 0x80000000) {
      const nameOffset = rsrcBaseOffset + (nameOrId & 0x7FFFFFFF);
      const nameLen = readUint16(dv, nameOffset);
      name = readUtf16(dv, nameOffset + 2, nameLen);
    } else {
      id = nameOrId;
    }

    if (offsetToData & 0x80000000) {
      const subDirOffset = offsetToData & 0x7FFFFFFF;
      const children = parseResourceDirectory(dv, rsrcBaseOffset, subDirOffset, level + 1, sections);
      entries.push({ id, name, children });
    } else {
      const dataEntryAbs = rsrcBaseOffset + offsetToData;
      const dataRva = readUint32(dv, dataEntryAbs);
      const dataSize = readUint32(dv, dataEntryAbs + 4);
      const codePage = readUint32(dv, dataEntryAbs + 8);
      entries.push({ id, name, dataRva, dataSize, codePage });
    }
  }

  return entries;
}

const CODEPAGE_MAP: Record<number, string> = {
  936: 'gbk', 950: 'big5', 932: 'shift_jis', 949: 'euc-kr',
  1250: 'windows-1250', 1251: 'windows-1251', 1252: 'windows-1252',
  1253: 'windows-1253', 1254: 'windows-1254', 1255: 'windows-1255',
  1256: 'windows-1256', 1257: 'windows-1257', 1258: 'windows-1258',
  874: 'windows-874', 1361: 'euc-kr',
};

function detectNEEncoding(arrayBuffer: ArrayBuffer, resources: PEInfo['resources']): string {
  if (!resources) return 'windows-1252';
  const versionType = resources.find(r => r.typeId === 16);
  if (!versionType || versionType.entries.length === 0) return 'windows-1252';
  const lang = versionType.entries[0].languages[0];
  if (!lang) return 'windows-1252';

  // Scan for "Translation\0" in the version resource to find the codepage
  const bytes = new Uint8Array(arrayBuffer, lang.dataRva, lang.dataSize);
  const needle = [0x54, 0x72, 0x61, 0x6E, 0x73, 0x6C, 0x61, 0x74, 0x69, 0x6F, 0x6E, 0x00];
  for (let i = 0; i <= bytes.length - needle.length - 4; i++) {
    let match = true;
    for (let j = 0; j < needle.length; j++) {
      if (bytes[i + j] !== needle[j]) { match = false; break; }
    }
    if (match) {
      let pos = i + needle.length;
      pos = (pos + 3) & ~3; // DWORD align
      if (pos + 4 <= bytes.length) {
        const dv = new DataView(arrayBuffer, lang.dataRva + pos, 4);
        const codepage = dv.getUint16(2, true);
        return CODEPAGE_MAP[codepage] || 'windows-1252';
      }
    }
  }
  return 'windows-1252';
}

function parseNE(arrayBuffer: ArrayBuffer, e_lfanew: number): PEInfo {
  const dv = new DataView(arrayBuffer);
  const neOffset = e_lfanew;

  const resTableRel = readUint16(dv, neOffset + 0x24);
  const resBase = neOffset + resTableRel;

  // Virtual section so rvaToFileOffset(fileOffset, sections) returns fileOffset as-is
  const sections: SectionHeader[] = [{
    name: '.ne', virtualSize: arrayBuffer.byteLength, virtualAddress: 0,
    sizeOfRawData: arrayBuffer.byteLength, pointerToRawData: 0, characteristics: 0,
  }];

  if (resTableRel === 0) {
    return {
      dosHeader: { e_magic: 0x5A4D, e_lfanew },
      coffHeader: { machine: 0, numberOfSections: 0, timeDateStamp: 0, sizeOfOptionalHeader: 0, characteristics: 0 },
      optionalHeader: { magic: 0, isPE32Plus: false, subsystem: 0, dataDirectories: [] },
      sections, resources: null, isNE: true,
    };
  }

  const rscAlignShift = readUint16(dv, resBase);

  const typeMap = new Map<string, { typeId: number | null; typeName: string | null; entries: Map<string, { id: number | null; name: string | null; langs: { dataRva: number; dataSize: number }[] }> }>();

  let pos = resBase + 2;
  while (pos + 8 <= arrayBuffer.byteLength) {
    const rtTypeID = readUint16(dv, pos); pos += 2;
    if (rtTypeID === 0) break;
    const rtCount = readUint16(dv, pos); pos += 2;
    pos += 4; // skip reserved

    let typeId: number | null = null;
    let typeName: string | null = null;
    if (rtTypeID & 0x8000) {
      typeId = rtTypeID & 0x7FFF;
    } else {
      const nameOff = resBase + rtTypeID;
      const nameLen = dv.getUint8(nameOff);
      let n = '';
      for (let i = 0; i < nameLen; i++) n += String.fromCharCode(dv.getUint8(nameOff + 1 + i));
      typeName = n;
    }

    const typeKey = typeId != null ? `id:${typeId}` : `name:${typeName}`;
    if (!typeMap.has(typeKey)) {
      typeMap.set(typeKey, { typeId, typeName, entries: new Map() });
    }
    const typeInfo = typeMap.get(typeKey)!;

    for (let i = 0; i < rtCount; i++) {
      if (pos + 12 > arrayBuffer.byteLength) break;
      const rnOffset = readUint16(dv, pos); pos += 2;
      const rnLength = readUint16(dv, pos); pos += 2;
      pos += 2; // skip flags
      const rnID = readUint16(dv, pos); pos += 2;
      pos += 4; // skip handle + usage

      const fileOffset = rnOffset << rscAlignShift;
      const dataSize = rnLength << rscAlignShift;

      let entryId: number | null = null;
      let entryName: string | null = null;
      if (rnID & 0x8000) {
        entryId = rnID & 0x7FFF;
      } else {
        const nameOff = resBase + rnID;
        const nameLen = dv.getUint8(nameOff);
        let n = '';
        for (let j = 0; j < nameLen; j++) n += String.fromCharCode(dv.getUint8(nameOff + 1 + j));
        entryName = n;
      }

      const entryKey = entryId != null ? `id:${entryId}` : `name:${entryName}`;
      if (!typeInfo.entries.has(entryKey)) {
        typeInfo.entries.set(entryKey, { id: entryId, name: entryName, langs: [] });
      }
      typeInfo.entries.get(entryKey)!.langs.push({ dataRva: fileOffset, dataSize });
    }
  }

  const resources = [...typeMap.values()].map(t => ({
    typeId: t.typeId,
    typeName: t.typeName,
    typeLabel: t.typeId != null ? (RT_TYPES[t.typeId] || `Type ${t.typeId}`) : t.typeName!,
    entries: [...t.entries.values()].map(e => ({
      id: e.id,
      name: e.name,
      languages: e.langs.map(l => ({
        languageId: 0,
        dataRva: l.dataRva,
        dataSize: l.dataSize,
        codePage: 0,
      })),
    })),
  }));

  const neEncoding = detectNEEncoding(arrayBuffer, resources);

  return {
    dosHeader: { e_magic: 0x5A4D, e_lfanew },
    coffHeader: { machine: 0, numberOfSections: 0, timeDateStamp: 0, sizeOfOptionalHeader: 0, characteristics: 0 },
    optionalHeader: { magic: 0, isPE32Plus: false, subsystem: 0, dataDirectories: [] },
    sections, resources, isNE: true, neEncoding,
  };
}

function parseMZ(dv: DataView, arrayBuffer: ArrayBuffer): PEInfo {
  const mzHeader: MZHeader = {
    e_cblp: readUint16(dv, 0x02),
    e_cp: readUint16(dv, 0x04),
    e_crlc: readUint16(dv, 0x06),
    e_cparhdr: readUint16(dv, 0x08),
    e_minalloc: readUint16(dv, 0x0A),
    e_maxalloc: readUint16(dv, 0x0C),
    e_ss: readUint16(dv, 0x0E),
    e_sp: readUint16(dv, 0x10),
    e_ip: readUint16(dv, 0x14),
    e_cs: readUint16(dv, 0x16),
    e_lfarlc: readUint16(dv, 0x18),
    e_ovno: readUint16(dv, 0x1A),
  };

  return {
    dosHeader: { e_magic: 0x5A4D, e_lfanew: 0 },
    coffHeader: { machine: 0, numberOfSections: 0, timeDateStamp: 0, sizeOfOptionalHeader: 0, characteristics: 0 },
    optionalHeader: { magic: 0, isPE32Plus: false, subsystem: 0, dataDirectories: [] },
    sections: [],
    resources: null,
    isMZ: true,
    mzHeader,
  };
}

export function parseCOM(arrayBuffer: ArrayBuffer): PEInfo {
  return {
    dosHeader: { e_magic: 0, e_lfanew: 0 },
    coffHeader: { machine: 0, numberOfSections: 0, timeDateStamp: 0, sizeOfOptionalHeader: 0, characteristics: 0 },
    optionalHeader: { magic: 0, isPE32Plus: false, subsystem: 0, dataDirectories: [] },
    sections: [],
    resources: null,
    isCOM: true,
  };
}

export function parsePE(arrayBuffer: ArrayBuffer): PEInfo {
  const dv = new DataView(arrayBuffer);

  const e_magic = readUint16(dv, 0);
  if (e_magic !== 0x5A4D) {
    throw new Error('Not a valid DOS executable (missing MZ signature)');
  }
  const e_lfanew = readUint32(dv, 0x3C);

  // If e_lfanew points beyond the file, treat as plain MZ DOS executable
  if (e_lfanew + 4 > arrayBuffer.byteLength) {
    return parseMZ(dv, arrayBuffer);
  }

  // Check for NE (Win16) signature
  const sig16 = readUint16(dv, e_lfanew);
  if (sig16 === 0x454E) { // "NE" little-endian
    return parseNE(arrayBuffer, e_lfanew);
  }

  const peSignature = readUint32(dv, e_lfanew);
  if (peSignature !== 0x00004550) {
    // MZ-only DOS executable (no NE/PE signature)
    return parseMZ(dv, arrayBuffer);
  }

  const coffOffset = e_lfanew + 4;
  const coffHeader = {
    machine: readUint16(dv, coffOffset),
    numberOfSections: readUint16(dv, coffOffset + 2),
    timeDateStamp: readUint32(dv, coffOffset + 4),
    sizeOfOptionalHeader: readUint16(dv, coffOffset + 16),
    characteristics: readUint16(dv, coffOffset + 18),
  };

  const optOffset = coffOffset + 20;
  const magic = readUint16(dv, optOffset);
  const isPE32Plus = magic === 0x020B;
  const subsystem = readUint16(dv, optOffset + 68);

  let dataDirOffset: number;
  if (isPE32Plus) {
    dataDirOffset = optOffset + 112;
  } else {
    dataDirOffset = optOffset + 96;
  }

  const numberOfRvaAndSizes = readUint32(dv, dataDirOffset - 4);
  const dataDirectories = [];
  for (let i = 0; i < numberOfRvaAndSizes; i++) {
    dataDirectories.push({
      virtualAddress: readUint32(dv, dataDirOffset + i * 8),
      size: readUint32(dv, dataDirOffset + i * 8 + 4),
    });
  }

  const sectionOffset = optOffset + coffHeader.sizeOfOptionalHeader;
  const sections: SectionHeader[] = [];
  for (let i = 0; i < coffHeader.numberOfSections; i++) {
    const off = sectionOffset + i * 40;
    sections.push({
      name: readAscii(dv, off, 8),
      virtualSize: readUint32(dv, off + 8),
      virtualAddress: readUint32(dv, off + 12),
      sizeOfRawData: readUint32(dv, off + 16),
      pointerToRawData: readUint32(dv, off + 20),
      characteristics: readUint32(dv, off + 36),
    });
  }

  // UPX detection: section names UPX0/UPX1/UPX2 (and friends from upx variants
   // like .UPX0). UPX produces 2-3 sections: a zero-raw-size "decompressed
   // destination" (UPX0), a raw-data section with the compressed payload + stub
   // (UPX1), and optionally .rsrc with a bare directory.
  const isUpxPacked = sections.some(s => /^[\.\$]?UPX[0-9]/i.test(s.name));

  let resources = null;
  if (dataDirectories.length > 2 && dataDirectories[2].virtualAddress !== 0) {
    const rsrcRva = dataDirectories[2].virtualAddress;
    const rsrcBaseOffset = rvaToFileOffset(rsrcRva, sections);
    if (rsrcBaseOffset >= 0) {
      const rootEntries = parseResourceDirectory(dv, rsrcBaseOffset, 0, 0, sections);

      resources = rootEntries.map(typeEntry => ({
        typeId: typeEntry.id,
        typeName: typeEntry.name,
        typeLabel: typeEntry.id != null ? (RT_TYPES[typeEntry.id] || `Type ${typeEntry.id}`) : typeEntry.name!,
        entries: (typeEntry.children || []).map(nameEntry => ({
          id: nameEntry.id,
          name: nameEntry.name,
          languages: (nameEntry.children || []).map(langEntry => ({
            languageId: langEntry.id!,
            dataRva: langEntry.dataRva!,
            dataSize: langEntry.dataSize!,
            codePage: langEntry.codePage!,
          })),
        })),
      }));
    }
  }

  return {
    dosHeader: { e_magic, e_lfanew },
    coffHeader,
    optionalHeader: { magic, isPE32Plus, subsystem, dataDirectories },
    sections,
    resources,
    isUpxPacked: isUpxPacked || undefined,
  };
}
