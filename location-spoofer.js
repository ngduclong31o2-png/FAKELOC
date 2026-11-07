/*
 * Fake Location for Shadowrocket (independent implementation, MIT)
 *
 * Ý tưởng: iPhone gửi danh sách Wi-Fi/trạm phát tới Apple (/clls/wloc),
 * Apple trả về toạ độ của từng điểm. Script này sửa toạ độ trong phản hồi.
 *
 * Tham số (đặt trong argument= của module):
 *   latitude, longitude  toạ độ đích (độ thập phân, WGS-84)
 *   accuracy             (tuỳ chọn) độ chính xác ngang, mét. Bỏ trống = giữ giá trị gốc
 *   debug                1 = in log chi tiết
 *
 * Một file dùng cho cả request và response.
 */

const IS_REQUEST = typeof $response === "undefined";

function parseArgs(s) {
  const o = {};
  String(s || "").split("&").forEach((kv) => {
    const i = kv.indexOf("=");
    if (i > 0) o[decodeURIComponent(kv.slice(0, i)).trim()] = decodeURIComponent(kv.slice(i + 1)).trim();
  });
  return o;
}

const ARGS = parseArgs(typeof $argument !== "undefined" ? $argument : "");
const LAT = parseFloat(ARGS.latitude !== undefined ? ARGS.latitude : "21.0278");
const LON = parseFloat(ARGS.longitude !== undefined ? ARGS.longitude : "105.8342");
const ACC = ARGS.accuracy ? parseInt(ARGS.accuracy, 10) : null;
const DEBUG = ARGS.debug === "1" || ARGS.debug === "true";
const TAG = "[FakeLoc] ";

function log() {
  if (DEBUG) console.log(TAG + Array.prototype.slice.call(arguments).join(" "));
}

/* ---------------- Request: ép server trả dữ liệu không nén ---------------- */
function onRequest() {
  const h = $request.headers || {};
  Object.keys(h).forEach((k) => {
    if (k.toLowerCase() === "accept-encoding") delete h[k];
  });
  h["Accept-Encoding"] = "identity";
  $done({ headers: h });
}

/* ---------------- Protobuf tối giản ---------------- */
const MASK64 = (1n << 64n) - 1n;

function readVarint(buf, pos, end) {
  let r = 0n, shift = 0n;
  for (let i = 0; i < 10; i++) {
    if (pos >= end) return null;
    const b = buf[pos++];
    r |= BigInt(b & 0x7f) << shift;
    if (!(b & 0x80)) return { v: r & MASK64, pos };
    shift += 7n;
  }
  return null;
}

function writeVarint(v, out) {
  v = BigInt.asUintN(64, v);
  while (v > 0x7fn) {
    out.push(Number(v & 0x7fn) | 0x80);
    v >>= 7n;
  }
  out.push(Number(v));
}

// Trả về mảng field nếu buf[start,end) là protobuf hợp lệ và dùng hết byte; ngược lại null.
function parseMsg(buf, start, end) {
  const fields = [];
  let pos = start;
  while (pos < end) {
    const t = readVarint(buf, pos, end);
    if (!t) return null;
    pos = t.pos;
    const num = Number(t.v >> 3n);
    const wt = Number(t.v & 7n);
    if (num < 1) return null;
    const f = { num, wt };
    if (wt === 0) {
      const r = readVarint(buf, pos, end);
      if (!r) return null;
      f.v = r.v;
      pos = r.pos;
    } else if (wt === 1) {
      if (pos + 8 > end) return null;
      f.raw = buf.slice(pos, pos + 8);
      pos += 8;
    } else if (wt === 5) {
      if (pos + 4 > end) return null;
      f.raw = buf.slice(pos, pos + 4);
      pos += 4;
    } else if (wt === 2) {
      const l = readVarint(buf, pos, end);
      if (!l) return null;
      pos = l.pos;
      const len = Number(l.v);
      if (len < 0 || pos + len > end) return null;
      f.data = buf.slice(pos, pos + len);
      pos += len;
    } else {
      return null; // group: coi như không hợp lệ
    }
    fields.push(f);
  }
  return pos === end ? fields : null;
}

function serialize(fields) {
  const out = [];
  for (const f of fields) {
    writeVarint(BigInt((f.num << 3) | f.wt), out);
    if (f.wt === 0) writeVarint(f.v, out);
    else if (f.wt === 2) {
      writeVarint(BigInt(f.data.length), out);
      for (let i = 0; i < f.data.length; i++) out.push(f.data[i]);
    } else for (let i = 0; i < f.raw.length; i++) out.push(f.raw[i]);
  }
  return Uint8Array.from(out);
}

const toSigned = (v) => BigInt.asIntN(64, v);

function looksLikeText(d) {
  if (d.length === 0) return true;
  for (let i = 0; i < d.length; i++) if (d[i] < 0x20 || d[i] > 0x7e) return false;
  return true;
}

// Một "Location" trong phản hồi Apple: field1=lat, field2=lon (int64, đơn vị 1e-8 độ), field3=độ chính xác.
function isLocation(fields) {
  const f1 = fields.find((f) => f.num === 1 && f.wt === 0);
  const f2 = fields.find((f) => f.num === 2 && f.wt === 0);
  const f3 = fields.find((f) => f.num === 3 && f.wt === 0);
  if (!f1 || !f2 || !f3) return false;
  const lat = Number(toSigned(f1.v)) / 1e8;
  const lon = Number(toSigned(f2.v)) / 1e8;
  // Apple dùng -180 làm giá trị "không biết" => bị loại ở đây và được giữ nguyên
  return Math.abs(lat) <= 90 && Math.abs(lon) <= 180 && !(lat === 0 && lon === 0);
}

const NEW_LAT = BigInt(Math.round(LAT * 1e8));
const NEW_LON = BigInt(Math.round(LON * 1e8));

let patched = 0;

function patch(fields) {
  let changed = false;
  if (isLocation(fields)) {
    for (const f of fields) {
      if (f.wt !== 0) continue;
      if (f.num === 1) f.v = BigInt.asUintN(64, NEW_LAT);
      else if (f.num === 2) f.v = BigInt.asUintN(64, NEW_LON);
      else if (f.num === 3 && ACC !== null) f.v = BigInt(ACC);
    }
    patched++;
    return true;
  }
  for (const f of fields) {
    if (f.wt !== 2 || looksLikeText(f.data)) continue;
    const kids = parseMsg(f.data, 0, f.data.length);
    if (kids && kids.length && patch(kids)) {
      f.data = serialize(kids);
      changed = true;
    }
  }
  return changed;
}

function concat(a, b) {
  const o = new Uint8Array(a.length + b.length);
  o.set(a, 0);
  o.set(b, a.length);
  return o;
}

/* Tìm đầu protobuf sau phần header của Apple rồi sửa. Trả về buffer mới hoặc null. */
function headerLenMatch(buf, off) {
  const total = buf.length - off;
  if (off >= 2 && ((buf[off - 2] << 8) | buf[off - 1]) === total) return 2;
  if (off >= 4 && (((buf[off - 4] << 24) | (buf[off - 3] << 16) | (buf[off - 2] << 8) | buf[off - 1]) >>> 0) === total) return 4;
  return 0;
}

function rewrite(buf) {
  // Thử mọi vị trí bắt đầu có thể; chọn nơi sửa được nhiều toạ độ nhất,
  // hoà thì ưu tiên nơi header có ghi đúng độ dài protobuf.
  let best = null;
  for (let off = 0; off <= Math.min(64, buf.length - 1); off++) {
    const fields = parseMsg(buf, off, buf.length);
    if (!fields || !fields.length) continue;
    patched = 0;
    patch(fields);
    if (patched === 0) continue;
    const lm = headerLenMatch(buf, off);
    if (!best || patched > best.count || (patched === best.count && lm > best.lm)) {
      best = { off, fields, count: patched, lm };
    }
  }
  if (!best) return null;
  patched = best.count;
  const body = serialize(best.fields);
  const head = buf.slice(0, best.off);
  const oldLen = buf.length - best.off;
  const newLen = body.length;
  if (best.lm === 2) {
    head[best.off - 2] = (newLen >> 8) & 0xff;
    head[best.off - 1] = newLen & 0xff;
  } else if (best.lm === 4) {
    head[best.off - 4] = (newLen >>> 24) & 0xff;
    head[best.off - 3] = (newLen >>> 16) & 0xff;
    head[best.off - 2] = (newLen >>> 8) & 0xff;
    head[best.off - 1] = newLen & 0xff;
  }
  log("protobuf bắt đầu ở byte", best.off, "| header ghi độ dài:", best.lm ? best.lm + " byte" : "không", "| đã sửa", best.count, "vị trí | dài", oldLen, "->", newLen);
  return concat(head, body);
}

function main() {
  try {
    if (!isFinite(LAT) || !isFinite(LON) || Math.abs(LAT) > 90 || Math.abs(LON) > 180) {
      console.log(TAG + "Toạ độ không hợp lệ, bỏ qua (trả dữ liệu gốc).");
      return $done({});
    }
    const hdr = $response.headers || {};
    const enc = Object.keys(hdr).find((k) => k.toLowerCase() === "content-encoding");
    if (enc && hdr[enc] && hdr[enc] !== "identity") {
      console.log(TAG + "Phản hồi bị nén (" + hdr[enc] + "), không xử lý được. Kiểm tra script request.");
      return $done({});
    }

    let useBytes = false, buf = null;
    if ($response.bodyBytes) {
      buf = new Uint8Array($response.bodyBytes);
      useBytes = true;
    } else if ($response.body instanceof Uint8Array) buf = $response.body;
    else if ($response.body instanceof ArrayBuffer) buf = new Uint8Array($response.body);

    if (!buf) {
      console.log(TAG + "Không nhận được body dạng nhị phân. Cần binary-body-mode trong module.");
      return $done({});
    }
    log("nhận", buf.length, "byte");

    const out = rewrite(buf);
    if (!out) {
      console.log(TAG + "Không tìm thấy toạ độ để sửa (Apple có thể đã đổi định dạng). Trả dữ liệu gốc.");
      return $done({});
    }
    console.log(TAG + "OK: đã đổi " + patched + " toạ độ -> " + LAT + "," + LON);
    // Content-Length cũ sẽ sai nếu độ dài đổi
    Object.keys(hdr).forEach((k) => { if (k.toLowerCase() === "content-length") delete hdr[k]; });
    $done(useBytes ? { headers: hdr, bodyBytes: out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength) } : { headers: hdr, body: out });
  } catch (e) {
    console.log(TAG + "Lỗi: " + e + " -> trả dữ liệu gốc");
    $done({});
  }
}

/* ---------------- Chạy ---------------- */
if (IS_REQUEST) onRequest();
else main();
