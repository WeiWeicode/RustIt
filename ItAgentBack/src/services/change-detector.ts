/**
 * 資產前後比對(PLATFORM-PLAN §4.3:軟硬體變更由 Server 比對,Agent 不記上一份;P5-MONITOR-DESIGN §3.2)。
 * 純函式:輸入同一台裝置前後兩份 ComputerInfo,輸出要寫入 ita.device_event 的主機事件(event_uid NULL、內容在 data)。
 *   - 軟體以名稱為鍵,同名多版本以版本集合比較 → software_installed / software_removed / software_updated;
 *     一份資產超過 BULK_LIMIT 項時改記一筆 software_changed_bulk(重灌、大量更新)
 *   - 硬體每個元件一筆 hardware_changed:記憶體(插槽 + 容量 + 料號;collector 沒有記憶體序號)、
 *     實體磁碟(兩邊都讀到序號時比序號,否則比「型號 + 容量」;排除 USB 外接)、顯示卡(名稱;排除遠端桌面與虛擬顯示卡)、BIOS 序號、
 *     主機板(序號 + 系統 UUID)、CPU 名稱
 */
import type { ComputerInfo } from '../contracts.js';

export interface HostEvent {
  type: 'software_installed' | 'software_removed' | 'software_updated' | 'software_changed_bulk' | 'hardware_changed';
  data: Record<string, unknown>;
}

/** 一份資產的軟體變更超過此數改記一筆彙總 */
export const BULK_LIMIT = 50;
/** 彙總事件列出的名稱數 */
const BULK_NAMES = 20;
/** 硬體變更前後各列出的項目數與每項長度:序列化後不超過告警 detail 的 2,000 字元,不被截成殘缺 JSON */
const HW_ITEMS = 8;
const HW_LABEL = 80;
/** 會隨登入狀態出現或消失的顯示卡(遠端桌面、虛擬、USB 顯示),不列入比對 */
const VIRTUAL_GPU = /remote|virtual|basic display|basic render|displaylink|parsec|hyper-v|vmware|virtualbox|citrix|indirect display/i;

type Software = ComputerInfo['software'][number];

function groupSoftware(list: Software[] | undefined): Map<string, { versions: string[]; publisher: string }> {
  const map = new Map<string, { versions: string[]; publisher: string }>();
  for (const s of list ?? []) {
    const name = s?.name?.trim();
    if (!name) continue;
    const g = map.get(name) ?? { versions: [], publisher: s.publisher ?? '' };
    g.versions.push(s.version ?? '');
    map.set(name, g);
  }
  for (const g of map.values()) g.versions.sort();
  return map;
}

const sameList = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i]);

function softwareChanges(prev: ComputerInfo, next: ComputerInfo): HostEvent[] {
  const before = groupSoftware(prev.software);
  const after = groupSoftware(next.software);
  const events: HostEvent[] = [];
  for (const [name, g] of after) {
    const old = before.get(name);
    if (!old) events.push({ type: 'software_installed', data: { name, version: g.versions.join(', '), publisher: g.publisher } });
    else if (!sameList(old.versions, g.versions))
      events.push({ type: 'software_updated', data: { name, publisher: g.publisher, from: old.versions.join(', '), to: g.versions.join(', ') } });
  }
  for (const [name, g] of before)
    if (!after.has(name)) events.push({ type: 'software_removed', data: { name, version: g.versions.join(', '), publisher: g.publisher } });
  if (events.length <= BULK_LIMIT) return events;
  const count = (t: HostEvent['type']) => events.filter((e) => e.type === t).length;
  return [
    {
      type: 'software_changed_bulk',
      data: {
        installed: count('software_installed'),
        removed: count('software_removed'),
        updated: count('software_updated'),
        names: events.slice(0, BULK_NAMES).map((e) => String(e.data.name)),
      },
    },
  ];
}

const gb = (bytes: number) => `${Math.round((bytes || 0) / 1024 ** 3)} GB`;
const isExternal = (d: ComputerInfo['physical_disks'][number]) => /usb/i.test(d.interface ?? '') || /removable|external/i.test(d.media_type ?? '');

/** 一個硬體項目:兩邊都有 id(磁碟序號)時比 id,否則比 alt(型號 + 容量等;磁碟序號有時讀不到) */
interface HwItem {
  id?: string;
  alt: string;
  label: string;
}

const sameItem = (a: HwItem, b: HwItem) => (a.id && b.id ? a.id === b.id : a.alt === b.alt);

/** 元件 → 項目與顯示文字 */
function hardwareKeys(info: ComputerInfo): Record<string, HwItem[]> {
  const one = (key: string, label = key) => (key.trim() ? [{ alt: key.trim(), label: label.trim() }] : []);
  return {
    memory: (info.memory_modules ?? []).map((m) => ({
      alt: `${m.slot}|${m.capacity}|${m.part_number}`,
      label: `${m.slot} ${gb(m.capacity)} ${m.manufacturer} ${m.part_number}`.trim(),
    })),
    disk: (info.physical_disks ?? [])
      .filter((d) => !isExternal(d))
      .map((d) => ({
        id: d.serial?.trim() || undefined,
        alt: `${d.model}|${d.size}`,
        label: `${d.model} ${gb(d.size)}${d.serial?.trim() ? ` 序號 ${d.serial.trim()}` : ''}`,
      })),
    gpu: (info.gpus ?? []).filter((g) => g.name?.trim() && !VIRTUAL_GPU.test(g.name)).map((g) => ({ alt: g.name.trim(), label: g.name.trim() })),
    bios: one(info.identity?.bios_serial ?? ''),
    board: one(
      `${info.identity?.board_serial ?? ''}|${info.identity?.system_uuid ?? ''}`.replace(/^\|$/, ''),
      `${info.identity?.board_product ?? ''} 序號 ${info.identity?.board_serial ?? ''}`,
    ),
    cpu: one(info.cpu?.name ?? ''),
  };
}

/** 數量相同,且每個舊項目都能對到一個尚未配對的相同新項目 */
function sameItems(before: HwItem[], after: HwItem[]): boolean {
  if (before.length !== after.length) return false;
  const used = new Set<number>();
  return before.every((b) => {
    const i = after.findIndex((a, k) => !used.has(k) && sameItem(a, b));
    if (i < 0) return false;
    used.add(i);
    return true;
  });
}

function hardwareChanges(prev: ComputerInfo, next: ComputerInfo): HostEvent[] {
  const a = hardwareKeys(prev);
  const b = hardwareKeys(next);
  const events: HostEvent[] = [];
  for (const component of Object.keys(b)) {
    const before = a[component] ?? [];
    const after = b[component] ?? [];
    // 舊資料沒有這個元件(例如當時查不到)不視為變更,避免 WMI 偶發查不到時誤報;反之亦然
    if (before.length === 0 || after.length === 0) continue;
    if (sameItems(before, after)) continue;
    const labels = (x: HwItem[]) => x.slice(0, HW_ITEMS).map((i) => i.label.slice(0, HW_LABEL));
    events.push({ type: 'hardware_changed', data: { component, before: labels(before), after: labels(after) } });
  }
  return events;
}

/** 前一份為 null(第一次回報)不比對 */
export function detectChanges(prev: ComputerInfo | null, next: ComputerInfo): HostEvent[] {
  if (!prev) return [];
  return [...hardwareChanges(prev, next), ...softwareChanges(prev, next)];
}
