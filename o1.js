/* ---- adv/d2s.js ---- */
/* PD2 save decoder, browser port of adv/d2s.py (keep the two in lockstep).
 * Plain JS, no modules or dependencies.  Usage:
 *   var result = PD2Save.parse(arrayBuffer, DATA);          // DATA = contents of save-data.json
 *   var result = PD2Save.parse(arrayBuffer, DATA, true);    // strict: refuse data-overrides entries
 * Throws PD2Save.SaveFormatError on any inconsistency (it never guesses past a desync).
 * Code references (see SAVE_FORMAT.md): PD2 0x102E8F00 loader, D2Game 0x6FC74810 JM list,
 * D2Common #11145 0x6FD7C470, compact reader 0x6FD7C0C0, PD2 full item reader 0x102D8C40.
 */
(function (root) {
  'use strict';

  function SaveFormatError(msg) {
    this.name = 'SaveFormatError';
    this.message = msg;
    this.stack = (new Error(msg)).stack;
  }
  SaveFormatError.prototype = Object.create(Error.prototype);
  SaveFormatError.prototype.constructor = SaveFormatError;
  function fail(msg) { throw new SaveFormatError(msg); }
  function hex(n) { return '0x' + n.toString(16); }
  function pyrepr(s) { return "'" + s + "'"; }

  // ---------------- bit reader (Fog #10130 / #10129 / #10127) ----------------
  function Bits(buf, byteOff, byteEnd) {
    this.buf = buf; this.start = byteOff; this.pos = byteOff * 8; this.end = byteEnd * 8;
  }
  Bits.prototype.read = function (n) {
    if (n === 0) return 0;
    if (n > 32) fail('bit read of ' + n + ' bits');
    if (this.pos + n > this.end) fail('bit read past end of buffer at bit ' + this.pos + ' (+' + n + ')');
    var v = 0, mul = 1;
    for (var k = 0; k < n; k++) {
      var p = this.pos + k;
      if (this.buf[p >> 3] & (1 << (p & 7))) v += mul;
      mul *= 2;
    }
    this.pos += n;
    return v;
  };
  Bits.prototype.readSigned = function (n) {
    var v = this.read(n);
    if (n > 0 && n < 32 && Math.floor(v / Math.pow(2, n - 1)) % 2 === 1) v -= Math.pow(2, n);
    return v;
  };
  Bits.prototype.bytesUsed = function () {
    var used = this.pos - this.start * 8;
    return Math.floor((used + 7) / 8);
  };

  // ---------------- little-endian helpers ----------------
  function u8(b, o) { return b[o]; }
  function u16(b, o) { return b[o] | (b[o + 1] << 8); }
  function u32(b, o) { return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16)) + b[o + 3] * 16777216; }
  function tagIs(b, o, s) {
    for (var i = 0; i < s.length; i++) if (b[o + i] !== s.charCodeAt(i)) return false;
    return o + s.length <= b.length;
  }
  function bytesHex(b, a, e) {
    var s = '';
    for (var i = a; i < e; i++) s += (b[i] < 16 ? '0' : '') + b[i].toString(16);
    return s;
  }

  var I_NAME = 0, I_ENC = 1, I_CSVBITS = 2, I_CSVPARAM = 3, I_CSVSIGNED = 4, I_VALSHIFT = 5, I_SAVE = 7;
  function saveCols(r, sel) { var o = I_SAVE + 3 * sel; return [r[o], r[o + 1], r[o + 2]]; }

  var T_GOLD = 'gold', T_PLAY = 'play', T_CHARM = 'char', T_BOOK = 'book', T_SCROLL = 'scro',
      T_BODYPART = 'body', T_WEAPON = 'weap', T_ARMOR = 'armo';
  var F_IDENTIFIED = 0x10, F_SOCKETED = 0x800, F_EAR = 0x10000, F_COMPACT = 0x200000,
      F_ETHEREAL = 0x400000, F_PERSONALIZED = 0x1000000, F_BIT25 = 0x2000000, F_RUNEWORD = 0x4000000;
  var STAT_GROUPS = {
    17: [[17, 'G'], [18, 'G']], 48: [[48, 'V'], [49, 'V']], 50: [[50, 'G'], [51, 'V']],
    52: [[52, 'G'], [53, 'G']], 54: [[54, 'G'], [55, 'V'], [56, 'G']], 57: [[57, 'V'], [58, 'V'], [59, 'G']]
  };
  var MODE_NAMES = {0: 'stored', 1: 'equipped', 2: 'belt', 3: 'ground', 4: 'cursor', 5: 'dropping', 6: 'socketed'};
  var PAGE_NAMES = {0: 'inventory', 3: 'cube', 4: 'stash_page4', 5: 'stash'};
  var QUALITY_NAMES = {1: 'low', 2: 'normal', 3: 'superior', 4: 'magic', 5: 'set', 6: 'rare', 7: 'unique',
                       8: 'crafted', 9: 'tempered'};
  function has(o, k) { return Object.prototype.hasOwnProperty.call(o, k); }
  function flag(f, m) { return Math.floor(f / m) % 2 === 1; }   // f may exceed 2^31

  // ---------------- tables ----------------
  function Tables(D, isc, items) {
    this.D = D; this.isc = isc; this.items = items; this.itemtypes = D.itemtypes;
    this.typeIndex = {};
    for (var n = 0; n < D.itemtypes.length; n++) {
      var c = D.itemtypes[n][0];
      if (c && !has(this.typeIndex, c)) this.typeIndex[c] = n;
    }
    this._equiv = {};
  }
  Tables.prototype.equiv = function (code) {
    if (has(this._equiv, code)) return this._equiv[code];
    var out = [], todo = [code];
    while (todo.length) {
      var c = todo.pop();
      if (!c || out.indexOf(c) >= 0) continue;
      out.push(c);
      if (has(this.typeIndex, c)) {
        var row = this.itemtypes[this.typeIndex[c]];
        todo.push(row[1]); todo.push(row[2]);
      }
    }
    this._equiv[code] = out;
    return out;
  };
  Tables.prototype.isType = function (code, t) {
    var b = this.items[code];
    if (this.equiv(b[2]).indexOf(t) >= 0) return true;
    return b[3] !== '' && this.equiv(b[3]).indexOf(t) >= 0;
  };

  function read7bitString(br) {
    var s = '';
    for (;;) { var c = br.read(7); if (c === 0) return s; s += String.fromCharCode(c); }
  }

  // ---------------- decoder ----------------
  function Decoder(D, strict) {
    this.D = D; this.strict = !!strict; this.warnings = []; this.inferredIsc = {};
    var ov = D.overrides || {items: {}, isc: {}};
    this.overrideItems = this.strict ? {} : ov.items;
    var isc = D.isc, k;
    if (!this.strict && Object.keys(ov.isc).length) {
      isc = D.isc.map(function (r) { return r.slice(); });
      var keys = Object.keys(ov.isc).sort(function (a, b) { return (+a) - (+b); });
      for (var i = 0; i < keys.length; i++) {
        k = keys[i];
        var e = ov.isc[k], o = I_SAVE + 3 * e[0];
        isc[+k][o] = e[1]; isc[+k][o + 1] = e[2]; isc[+k][o + 2] = e[3];
        this.inferredIsc[k + '/' + e[0]] = true;
      }
    }
    var items = D.items;
    var okeys = Object.keys(this.overrideItems);
    if (okeys.length) {
      items = {};
      for (k in D.items) if (has(D.items, k)) items[k] = D.items[k];
      okeys.sort();
      for (var j = 0; j < okeys.length; j++) items[okeys[j]] = this.overrideItems[okeys[j]];
    }
    this.t = new Tables(D, isc, items);
  }
  Decoder.prototype.warn = function (m) { if (this.warnings.indexOf(m) < 0) this.warnings.push(m); };

  Decoder.prototype.statEntry = function (sid, param, value, sel, groupOf) {
    var r = this.t.isc[sid];
    var e = {id: sid, name: r[I_NAME], param: param, values: [value], encode: r[I_ENC],
             valshift: r[I_VALSHIFT], columns: sel};
    if (groupOf !== null) e.group_of = groupOf;
    if (has(this.inferredIsc, sid + '/' + sel)) {
      e.inferred = true;
      this.warn('stat ' + sid + ' (' + r[I_NAME] + '): save width taken from data-overrides.json (inferred, not in data.zip)');
    }
    if (r[I_ENC] === 2) {
      e.decoded = {skill: Math.floor(param / 64), level: param % 64, chance: value};
    } else if (r[I_ENC] === 3) {
      e.decoded = {skill: Math.floor(param / 64), level: param % 64, charges: ((value % 256) + 256) % 256,
                   max_charges: Math.floor(value / 256)};
    }
    return e;
  };
  Decoder.prototype.readOne = function (br, sid, kind, sel, groupOf, out) {
    var r = this.t.isc[sid], c = saveCols(r, sel), bits = c[0], add = c[1], pbits = c[2];
    if (bits <= 0) fail('stat ' + sid + ' (' + r[I_NAME] + ') has 0 save bits in column set ' + sel +
                        ' (bit ' + br.pos + '): bitstream desync?');
    var param = 0;
    if (kind === 'G' && pbits > 0) param = br.read(pbits) % 65536;
    var v = br.read(bits) - add;
    out.push(this.statEntry(sid, param, v, sel, groupOf));
  };
  Decoder.prototype.readStatList = function (br, sel, idbits) {
    var term = Math.pow(2, idbits) - 1, out = [];
    for (;;) {
      var sid = br.read(idbits);
      if (sid === term) return out;
      if (sid >= this.t.isc.length) fail('stat id ' + sid + ' out of ItemStatCost range at bit ' + (br.pos - idbits));
      if (has(STAT_GROUPS, sid)) {
        var g = STAT_GROUPS[sid];
        for (var i = 0; i < g.length; i++) this.readOne(br, g[i][0], g[i][1], sel, g[i][0] !== sid ? sid : null, out);
      } else {
        this.readOne(br, sid, 'G', sel, null, out);
      }
    }
  };

  Decoder.prototype.readItem = function (buf, off, end, version) {
    var br = new Bits(buf, off, end);
    if (br.read(16) !== 0x4D4A) fail('item at ' + hex(off) + ' does not start with JM');
    var flags = br.read(32);
    var bit25 = flag(flags, F_BIT25);
    if (bit25) flags -= F_BIT25;
    var it = {offset: off, flags: flags,
              identified: flag(flags, F_IDENTIFIED), is_socketed: flag(flags, F_SOCKETED),
              ear: flag(flags, F_EAR), compact: flag(flags, F_COMPACT),
              ethereal: flag(flags, F_ETHEREAL), personalized: flag(flags, F_PERSONALIZED),
              runeword_flag: flag(flags, F_RUNEWORD)};
    if (bit25) it.flag_bit25 = true;
    var iv = br.read(10);
    it.item_version = iv;
    var mode = br.read(3);
    var loc = {mode: mode, parent: has(MODE_NAMES, mode) ? MODE_NAMES[mode] : 'mode' + mode};
    if (mode === 3 || mode === 5) {
      loc.x = br.read(16); loc.y = br.read(16); loc.bodyloc = 0; loc.page = -1; loc.storage = null;
    } else {
      loc.bodyloc = br.read(4); loc.x = br.read(4); loc.y = br.read(4);
      var page = br.read(3) - 1;
      loc.page = page;
      loc.storage = page >= 0 && has(PAGE_NAMES, page) ? PAGE_NAMES[page] : null;
    }
    var bl = loc.bodyloc;
    loc.bodyloc_code = (bl > 0 && bl < this.D.bodylocs.length) ? this.D.bodylocs[bl] : null;
    it.location = loc;
    var nchildren = 0;
    if (flag(flags, F_COMPACT)) this.readCompact(br, it, version);
    else nchildren = this.readFull(br, it, version, bit25, iv);
    it.bits = br.pos - off * 8;
    // Fog #10128 (0x6FF641BE) zeroes each new byte: unused high bits of the last byte must be 0
    var pad = (8 - (it.bits % 8)) % 8;
    if (pad && (buf[off + br.bytesUsed() - 1] >> (8 - pad))) fail('item at ' + hex(off) + ': non-zero padding after bit ' + it.bits + ' (desync)');
    var ks = ['set_id', 'unique_id', 'defense', 'durability', 'quantity', 'sockets', 'ilvl'];
    for (var i = 0; i < ks.length; i++) if (!has(it, ks[i])) it[ks[i]] = null;
    if (!has(it, 'prefixes')) it.prefixes = [];
    if (!has(it, 'suffixes')) it.suffixes = [];
    it.socketed = [];
    it.runeword = null;
    return [it, br.bytesUsed(), nchildren];
  };

  Decoder.prototype.base = function (it, codeInt) {
    var code = '';
    for (var k = 0; k < 4; k++) code += String.fromCharCode(Math.floor(codeInt / Math.pow(256, k)) % 256);
    var key = code.replace(/ +$/, ''), b;
    if (has(this.D.items, key)) {
      b = this.t.items[key];
    } else if (has(this.overrideItems, key)) {
      b = this.t.items[key];
      it.base_inferred = true;
      this.warn('item code ' + pyrepr(key) + ' is not in data.zip; structure taken from data-overrides.json (inferred)');
    } else {
      fail('unknown item code ' + pyrepr(code) + ' at item ' + hex(it.offset));
    }
    it.code = key; it.name = b[0]; it.category = b[1]; it.type = b[2]; it.type2 = b[3] ? b[3] : null;
    return [key, b];
  };
  Decoder.prototype.readEar = function (br, it) {
    var cls = br.read(3), lvl = br.read(7);
    it.ear_data = {'class': cls, level: lvl, name: read7bitString(br)};
  };
  Decoder.prototype.emptyLists = function (it) { it.stats = []; it.set_bonus_lists = []; it.runeword_stats = []; };
  Decoder.prototype.readRealm = function (br, it, version) {
    if (version > 0x56) {
      if (br.read(1)) {
        var a = br.read(32), b = br.read(32), c = version > 0x5D ? br.read(32) : null;
        it.realm_data = [a, b, c];
      }
    }
  };
  Decoder.prototype.readCompact = function (br, it, version) {
    if (flag(it.flags, F_EAR)) {
      this.readEar(br, it);
      it.code = 'ear'; it.name = 'Ear'; it.category = 'ear'; it.type = 'play'; it.type2 = null;
    } else {
      var cb = this.base(it, br.read(32)), code = cb[0], b = cb[1];
      if (this.t.isType(code, T_GOLD)) { var big = br.read(1); it.gold = br.read(big ? 32 : 12); }
      if (version > 0x5C && b[5] && b[6]) {
        var c = saveCols(this.t.isc[356], 0);
        it.quest_difficulty = br.read(c[0]) - c[1];
      }
    }
    this.readRealm(br, it, version);
    it.quality = 2; it.quality_name = 'normal';
    this.emptyLists(it);
  };
  Decoder.prototype.readFull = function (br, it, version, bit25, iv) {
    var sel = iv <= 0x66 ? 2 : (version < 0x5D ? 1 : 0);
    var idbits = iv >= 0x66 ? 10 : 9;
    it.save_columns = sel; it.stat_id_bits = idbits;
    var cb = this.base(it, br.read(32)), code = cb[0], b = cb[1], v;
    if (bit25) { this.emptyLists(it); return 0; }
    var nchildren = br.read(3);
    it.socketed_count = nchildren;
    it.id = br.read(32);
    it.ilvl = br.read(7);
    var q = br.read(4);
    it.quality = q;
    it.quality_name = has(QUALITY_NAMES, q) ? QUALITY_NAMES[q] : 'q' + q;
    if (br.read(1)) it.gfx = br.read(3);
    if (br.read(1)) { v = br.read(11); it.automagic = {id: v, name: this.name(this.D.automagic, v)}; }
    if (q === 1 || q === 3) {
      v = br.read(3); it.quality_sub = v;
      if (q === 1) it.low_quality = {id: v, name: this.name(this.D.lowquality, v)};
    } else if (q === 2) {
      if (this.t.isType(code, T_CHARM)) {
        if (br.read(1)) it.prefixes = [this.affix('magicprefix', br.read(11))];
        else it.suffixes = [this.affix('magicsuffix', br.read(11))];
      }
      if (this.t.isType(code, T_BODYPART) && !this.t.isType(code, T_PLAY)) it.file_index = br.read(10);
      if (this.t.isType(code, T_SCROLL) || this.t.isType(code, T_BOOK)) it.spell_id = br.read(5);
    } else if (q === 4) {
      var p = br.read(11), s = br.read(11);
      it.prefixes = [this.affix('magicprefix', p)];
      it.suffixes = [this.affix('magicsuffix', s)];
    } else if (q === 6 || q === 8) {
      var n1 = br.read(8), n2 = br.read(8);
      it.rare_name = {id1: n1, id2: n2, name1: this.rareName(n1), name2: this.rareName(n2)};
      var pre = [], suf = [];
      for (var k = 0; k < 3; k++) {
        if (br.read(1)) pre.push(this.affix('magicprefix', br.read(11)));
        if (br.read(1)) suf.push(this.affix('magicsuffix', br.read(11)));
      }
      it.prefixes = pre; it.suffixes = suf;
    } else if (q === 5) {
      v = br.read(12);
      it.set_id = v;
      if (v < this.D.setitems.length) {
        it.set_item = this.D.setitems[v];
      } else {
        it.set_item = null;
        this.warn('set item id ' + v + ' is beyond SetItems.txt (' + this.D.setitems.length + ' rows): name unknown');
      }
    } else if (q === 7) {
      v = br.read(12);
      if (v >= this.D.unique.length) v = -1;
      it.unique_id = v;
      it.unique_name = v >= 0 ? this.D.unique[v] : null;
    } else if (q === 9) {
      var ta = br.read(8), tb = br.read(8);
      it.tempered_names = [ta, tb];
    } else {
      fail('invalid quality ' + q + ' at item ' + hex(it.offset));
    }
    if (flag(it.flags, F_RUNEWORD)) it.runeword_raw = br.read(16);
    if (flag(it.flags, F_EAR)) this.readEar(br, it);
    else if (flag(it.flags, F_PERSONALIZED)) it.personalized_name = read7bitString(br);
    this.readRealm(br, it, version);

    var c;
    if (this.t.isType(code, T_ARMOR)) {
      c = saveCols(this.t.isc[31], sel);
      it.defense = br.read(c[0]) - c[1];
      this.readDurability(br, it, version, sel);
    } else if (this.t.isType(code, T_WEAPON)) {
      this.readDurability(br, it, version, sel);
    } else if (this.t.isType(code, T_GOLD)) {
      var big = br.read(1); it.gold = br.read(big ? 32 : 12);
    }
    if (b[4]) it.quantity = br.read(version >= 0x51 ? 9 : 8);
    if (flag(it.flags, F_SOCKETED)) {
      c = saveCols(this.t.isc[194], sel);
      it.sockets = br.read(c[0]);
    }
    var setmask = 0;
    if (version > 0x54 && q === 5) { setmask = br.read(5); it.set_list_mask = setmask; }
    it.stats = this.readStatList(br, sel, idbits);
    it.set_bonus_lists = [];
    for (var bit = 0; bit < 5; bit++) {
      if (setmask & (1 << bit)) it.set_bonus_lists.push({mask_bit: bit, stats: this.readStatList(br, sel, idbits)});
    }
    it.runeword_stats = flag(it.flags, F_RUNEWORD) ? this.readStatList(br, sel, idbits) : [];
    return nchildren;
  };
  Decoder.prototype.readDurability = function (br, it, version, sel) {
    var m = saveCols(this.t.isc[73], sel);
    var mx = br.read(m[0]) - m[1], cur = null;
    if (mx !== 0) {
      var c = saveCols(this.t.isc[72], sel), cbits = c[0];
      if (version < 0x60) cbits = 8;
      cur = br.read(cbits) - c[1];
    }
    it.durability = {cur: cur, max: mx};
  };
  Decoder.prototype.name = function (tbl, v) { return (v >= 0 && v < tbl.length) ? tbl[v] : null; };
  Decoder.prototype.affix = function (t, v) { return {id: v, name: v ? this.name(this.D[t], v) : null}; };
  Decoder.prototype.rareName = function (v) {
    var suf = this.D.raresuffix, pre = this.D.rareprefix;
    if (v <= 0) return null;
    v -= 1;
    if (v < suf.length) return suf[v];
    if (v - suf.length < pre.length) return pre[v - suf.length];
    return null;
  };
  Decoder.prototype.resolveRuneword = function (it) {
    if (!it.runeword_flag) { it.runeword = null; return; }
    var codes = it.socketed.map(function (c) { return c.code; });
    var rw = {raw: has(it, 'runeword_raw') ? it.runeword_raw : null, rune_codes: codes, id: null, key: null, name: null};
    var runes = this.D.runes;
    for (var n = 0; n < runes.length; n++) {
      var r = runes[n];
      if (r[2] && r[3].length === codes.length && r[3].every(function (x, i) { return x === codes[i]; }) &&
          this.rwTypeOk(it.code, r[4], r[5])) {
        rw.id = n; rw.key = r[0]; rw.name = r[1];
        break;
      }
    }
    it.runeword = rw;
  };
  Decoder.prototype.rwTypeOk = function (code, itypes, etypes) {
    var ok = false, i;
    for (i = 0; i < itypes.length; i++) if (this.t.isType(code, itypes[i])) ok = true;
    if (ok) for (i = 0; i < etypes.length; i++) if (this.t.isType(code, etypes[i])) return false;
    return ok;
  };

  Decoder.prototype.readItemList = function (buf, off, end, version, where) {
    if (!tagIs(buf, off, 'JM')) fail(where + ': expected JM list header at ' + hex(off));
    var count = u16(buf, off + 2);
    off += 4;
    var items = [];
    for (var i = 0; i < count; i++) {
      var r = this.readItem(buf, off, end, version), it = r[0];
      off += r[1];
      var kids = [];
      for (var k = 0; k < r[2]; k++) {
        var rc = this.readItem(buf, off, end, version), ch = rc[0];
        if (rc[2]) fail('socketed child at ' + hex(off) + ' claims children');
        if (ch.location.mode !== 6) fail('socketed child at ' + hex(off) + ' has mode ' + ch.location.mode + ', expected 6');
        off += rc[1];
        kids.push(ch);
      }
      it.socketed = kids;
      this.resolveRuneword(it);
      items.push(it);
    }
    return [items, off];
  };

  Decoder.prototype.parseD2s = function (buf) {
    var D = this.D, i, k;
    if (buf.length < 0x2FD) fail('file too small');
    var magic = u32(buf, 0), version = u32(buf, 4), size = u32(buf, 8), checksum = u32(buf, 12);
    if (magic !== 0xAA55AA55) fail('bad magic ' + magic.toString(16));
    if (version !== 0x60) fail('only save version 0x60 (1.10-1.13) is implemented; got ' + hex(version));
    if (size !== buf.length) fail('header size ' + size + ' != file size ' + buf.length);
    var calc = checksum32(buf);
    if (calc !== checksum) fail('checksum mismatch: header ' + checksum.toString(16) + ' computed ' + calc.toString(16));
    var name = '';
    for (i = 0x14; i < 0x24 && buf[i] !== 0; i++) name += String.fromCharCode(buf[i]);
    var status = buf[0x24], cls = buf[0x28];
    if (cls >= D.classes.length) fail('class ' + cls + ' out of range');
    var out = {version: version, name: name, 'class': {id: cls, name: D.classes[cls][0]},
               level: buf[0x2B], status: status,
               hardcore: (status & 0x04) !== 0, died: (status & 0x08) !== 0,
               expansion: (status & 0x20) !== 0, ladder: (status & 0x40) !== 0,
               progression: buf[0x25],
               header: {checksum: checksum, active_weapon: u32(buf, 0x10), byte_29: buf[0x29],
                        skill_count: buf[0x2A], created: u32(buf, 0x2C), last_played: u32(buf, 0x30),
                        difficulty: [buf[0xA8], buf[0xA9], buf[0xAA]], map_id: u32(buf, 0xAB)}};
    var pos = 0x14F;
    if (!tagIs(buf, pos, 'Woo!') || u32(buf, pos + 4) !== 6) fail('quest section not found at 0x14F');
    pos += 0x12A;
    if (!tagIs(buf, pos, 'WS')) fail('expected WS at ' + hex(pos));
    pos += 0x50;
    if (!(buf[pos] === 1 && buf[pos + 1] === 0x77)) fail('expected NPC section (01 77) at ' + hex(pos));
    pos += 0x34;
    if (!tagIs(buf, pos, 'gf')) fail('gf section not at ' + hex(pos));
    // 'gf' (D2Game 0x6FD0B910)
    var br = new Bits(buf, pos + 2, buf.length), stats = {}, rawStats = [];
    for (;;) {
      var sid = br.read(9);
      if (sid >= 0x1FF) break;
      if (sid >= this.t.isc.length) fail('gf stat id ' + sid + ' out of range');
      var r = this.t.isc[sid], csvBits = r[I_CSVBITS], csvParam = r[I_CSVPARAM];
      if (csvBits <= 0) fail('gf stat ' + sid + ' has CSvBits 0');
      var param = csvParam > 0 ? br.read(csvParam) : 0;
      var v = (csvBits < 32 && r[I_CSVSIGNED]) ? br.readSigned(csvBits) : br.read(csvBits);
      rawStats.push({id: sid, name: r[I_NAME], param: param, value: v});
      stats[sid] = v;
    }
    pos = pos + 2 + br.bytesUsed();
    var attrIds = [['strength', 0], ['energy', 1], ['dexterity', 2], ['vitality', 3], ['statpts', 4],
                   ['newskills', 5], ['hitpoints', 6], ['maxhp', 7], ['mana', 8], ['maxmana', 9],
                   ['stamina', 10], ['maxstamina', 11], ['level', 12], ['experience', 13], ['gold', 14],
                   ['goldbank', 15]];
    var attrs = {};
    for (i = 0; i < attrIds.length; i++) {
      var aid = attrIds[i][1], av = has(stats, aid) ? stats[aid] : 0, vs = this.t.isc[aid][I_VALSHIFT];
      attrs[attrIds[i][0]] = vs ? av / Math.pow(2, vs) : av;
    }
    out.attributes = attrs;
    out.attributes_raw = rawStats;
    // 'if' skills
    if (!tagIs(buf, pos, 'if')) fail('expected if at ' + hex(pos));
    var n = buf[0x2A], clsSk = D.classskills[cls], skills = [];
    for (k = 0; k < n; k++) {
      if (k >= clsSk.length) fail('skill slot ' + k + ' beyond class skill list (' + clsSk.length + ')');
      skills.push({id: clsSk[k], name: D.skills[clsSk[k]], level: buf[pos + 2 + k]});
    }
    out.skills = skills;
    pos += 2 + n;
    var rl = this.readItemList(buf, pos, buf.length, version, 'player items');
    out.items = rl[0]; pos = rl[1];
    // corpses
    if (!tagIs(buf, pos, 'JM')) fail('expected corpse JM at ' + hex(pos));
    var ncorpse = u16(buf, pos + 2);
    if (ncorpse > 1) fail('corpse count ' + ncorpse + ' > 1');
    pos += 4;
    var corpses = [];
    for (i = 0; i < ncorpse; i++) {
      var head = [u32(buf, pos), u32(buf, pos + 4), u32(buf, pos + 8)];
      pos += 12;
      var rc = this.readItemList(buf, pos, buf.length, version, 'corpse items');
      pos = rc[1];
      corpses.push({header: head, items: rc[0]});
    }
    out.corpses = corpses;
    // mercenary
    var mflags = u32(buf, 0xAF), mseed = u32(buf, 0xB3), mname = u16(buf, 0xB7), mtype = u16(buf, 0xB9),
        mexp = u32(buf, 0xBB);
    var mercExists = mexp !== 0 || mseed !== 0 || mname !== 0, hire = null;
    if (mercExists) {
      var ver = out.expansion ? 100 : 0;
      for (i = 0; i < D.hireling.length; i++) {
        if (D.hireling[i][0] === mtype && D.hireling[i][1] === ver) { hire = D.hireling[i]; break; }
      }
      mercExists = hire !== null;
    }
    var merc = {flags: mflags, dead: flag(mflags, 0x10000), seed: mseed, name_id: mname, type: mtype,
                experience: mexp, exists: mercExists,
                hireling: hire ? {hireling: hire[2], subtype: hire[3], act: hire[4], difficulty: hire[5]} : null,
                items: []};
    out.golem = null;
    if (out.expansion) {
      if (!tagIs(buf, pos, 'jf')) fail('expected jf at ' + hex(pos));
      pos += 2;
      if (mercExists) { var rm = this.readItemList(buf, pos, buf.length, version, 'merc items'); merc.items = rm[0]; pos = rm[1]; }
      if (!tagIs(buf, pos, 'kf')) fail('expected kf at ' + hex(pos));
      var hasGolem = buf[pos + 2];
      pos += 3;
      if (hasGolem && tagIs(buf, pos, 'JM')) {
        var rg = this.readItem(buf, pos, buf.length, version), g = rg[0];
        pos += rg[1];
        var kids = [];
        for (k = 0; k < rg[2]; k++) { var rk = this.readItem(buf, pos, buf.length, version); pos += rk[1]; kids.push(rk[0]); }
        g.socketed = kids;
        this.resolveRuneword(g);
        out.golem = g;
      }
    }
    out.mercenary = merc;
    out.pd2 = this.parsePdBlock(buf, pos);
    return out;
  };

  Decoder.prototype.parsePdBlock = function (buf, pos) {
    if (pos === buf.length) return null;
    if (!tagIs(buf, pos, 'pd')) fail('unexpected data at ' + hex(pos) + ' (expected PD2 "pd" block or EOF)');
    var ver = u16(buf, pos + 2), i;
    pos += 4;
    var res = {version: ver};
    this.tag(buf, pos, 'su');
    var n = buf[pos + 2];
    if (n > 0x80) fail('su count ' + n);
    res.su = [];
    for (i = 0; i < n; i++) res.su.push(u16(buf, pos + 3 + 2 * i));
    pos += 3 + 2 * n;
    this.tag(buf, pos, 'bk');
    res.bk = u32(buf, pos + 2);
    pos += 6;
    this.tag(buf, pos, 'st');
    var p = pos + 2, st = [];
    st.push(u32(buf, p), u32(buf, p + 4)); p += 8;
    for (i = 0; i < 4; i++) st.push(u16(buf, p + 2 * i));
    p += 8;
    if (ver >= 0xA00) { st.push(u16(buf, p), u16(buf, p + 2)); p += 4; }
    for (i = 0; i < 11; i++) st.push(u16(buf, p + 2 * i));
    p += 22;
    if (ver >= 0xA81) { for (i = 0; i < 5; i++) st.push(u32(buf, p + 4 * i)); p += 20; }
    res.st = st;
    pos = p;
    if (ver >= 0x901) {
      this.tag(buf, pos, 'ht'); res.ht = buf[pos + 2]; pos += 3;
      this.tag(buf, pos, 'xp'); res.xp = buf[pos + 2]; pos += 3;
    }
    if (ver >= 0xA80) {
      this.tag(buf, pos, 'hc');
      res.hc = [];
      for (i = 0; i < 16; i++) {
        var o = pos + 2 + 8 * i;
        res.hc.push([u16(buf, o), u16(buf, o + 2), u32(buf, o + 4)]);
      }
      pos += 2 + 128;
    }
    if (pos !== buf.length) fail('PD2 block ends at ' + hex(pos) + ', file ends at ' + hex(buf.length));
    return res;
  };
  Decoder.prototype.tag = function (buf, pos, t) {
    if (!tagIs(buf, pos, t)) fail("expected b'" + t + "' at " + hex(pos));
  };

  Decoder.prototype.parseStash = function (buf, version) {
    if (version === undefined) version = 0x60;
    var magic = u32(buf, 0), ver = u32(buf, 4), size = u32(buf, 8), checksum = u32(buf, 12);
    if (magic !== 0xBB55BB55) fail('bad stash magic ' + magic.toString(16));
    if (size !== buf.length) fail('stash size field ' + size + ' != file size ' + buf.length);
    var calc = checksum32(buf);
    if (calc !== checksum) fail('stash checksum mismatch ' + checksum.toString(16) + ' vs ' + calc.toString(16));
    this.tag(buf, 0x10, 'st');
    this.tag(buf, 0x50, 'cu');
    var out = {kind: 'pd2_shared_stash', version: ver, checksum: checksum,
               st_block: bytesHex(buf, 0x12, 0x50), cu_block: bytesHex(buf, 0x52, 0x12E),
               st_first_dword: u32(buf, 0x12)};
    var r = this.readItemList(buf, 0x12E, buf.length, version, 'shared stash');
    if (r[1] !== buf.length) fail('stash item list ends at ' + hex(r[1]) + ', file ends at ' + hex(buf.length));
    out.items = r[0];
    return out;
  };

  function checksum32(buf) {
    var s = 0;
    for (var i = 0; i < buf.length; i++) {
      var b = (i >= 12 && i < 16) ? 0 : buf[i];
      s = (((s << 1) | (s >>> 31)) >>> 0);
      s = (s + b) >>> 0;
    }
    return s;
  }

  function parse(arrayBuffer, DATA, strict) {
    var buf = arrayBuffer instanceof Uint8Array ? arrayBuffer : new Uint8Array(arrayBuffer);
    var dec = new Decoder(DATA, strict), out;
    if (buf[0] === 0x55 && buf[1] === 0xAA && buf[2] === 0x55 && buf[3] === 0xAA) out = dec.parseD2s(buf);
    else if (buf[0] === 0x55 && buf[1] === 0xBB && buf[2] === 0x55 && buf[3] === 0xBB) out = dec.parseStash(buf);
    else fail('unknown file magic');
    out.warnings = dec.warnings;
    return out;
  }

  var api = {parse: parse, SaveFormatError: SaveFormatError, checksum32: checksum32};
  root.PD2Save = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));

/* ---- adv/re/auras.js ---- */
/* Which Skills.txt stat columns a skill's OWNER receives from its aura / state buff in Project Diablo 2
   (1.13c D2Game + ProjectDiablo.dll). See auras.md for addresses; status READ (disassembly), not harness-verified.

   selfBuffStats(skill, lvl, blvl, { fromItem, isAura, srvdofunc, ownerMana })
     skill : a Skills.txt row (columns aurastat1..6 / passivestat1..5 / srvdofunc / aura / passivestate)
             or an engine.js record ({ as:[[stat,calc]..], ps:[[stat,calc]..], aura, pst } — srvdofunc from DOFUNC by opts.id
             or skill.id/skill.Id).
     returns [{ which: 'aura'|'passive', index }] — index is 0-based column position (aurastat1 -> 0); for engine records
             it is the index into sk.as / sk.ps. The caller evaluates the calcs with (lvl, blvl):
             lvl  = level the aura/buff runs at (cast level incl. +skills; item level for item_aura / item_skillonequip / charges),
             blvl = the owner's own hard points in THAT skill id (0 if none — e.g. CTA Battle Orders on a non-Barbarian,
                    The Beast Fanaticism on a non-Paladin). fromItem does not change the columns, only these values.
     Owner-side special stats (applied by the callback 0x6FCBA1A0, not as list stats): stat 110 (poison length) and
     ItemStatCost 'direct' stats such as hitpoints (Prayer heal) — see auras.md.
   affectsSelf(skill) -> true when the owner receives any stat list from the skill's own state (aurafilter is irrelevant:
             the area iteration 0x6FCC0C70 always excludes the owner; the do-func applies the owner's state directly).
   targetStats(skill) -> which columns OTHER units (party/merc/enemies) get: 'aura' | 'none'. */
(function (root) {
'use strict';

// srvdofunc per skill id for PD2 skills carrying aura/passive stats (generated from PD2 Skills.txt).
const DOFUNC = {"8":6,"17":6,"28":49,"30":13,"32":16,"40":25,"41":182,"42":160,"46":23,"50":18,"52":25,"60":18,"62":144,"66":30,"68":18,"70":31,"71":30,"72":30,"75":56,"77":30,"78":60,"80":31,"81":61,"85":56,"86":59,"87":30,"88":62,"89":31,"90":57,"91":30,"94":56,"95":58,"98":65,"99":65,"100":65,"102":66,"103":65,"104":65,"105":65,"106":13,"108":65,"109":65,"110":65,"113":65,"114":81,"115":65,"116":18,"117":18,"118":66,"119":66,"120":65,"122":65,"123":66,"125":65,"137":71,"138":68,"144":2,"146":68,"147":9,"149":68,"150":75,"151":76,"152":9,"155":68,"173":23,"196":101,"209":18,"210":18,"215":109,"221":114,"222":115,"223":116,"226":119,"227":119,"228":116,"230":182,"232":120,"233":120,"235":18,"236":119,"237":119,"242":165,"246":119,"247":119,"248":13,"254":170,"257":44,"258":18,"259":170,"261":45,"262":45,"264":47,"265":170,"267":18,"268":49,"269":170,"271":45,"272":45,"273":51,"274":170,"276":45,"278":18,"279":49,"280":170,"294":130,"295":131,"296":65,"297":65,"298":65,"309":30,"314":137,"328":109,"350":116,"360":68,"366":45,"367":157,"378":162,"380":76,"383":144,"388":116,"390":23,"391":18,"395":65,"396":65,"398":23,"406":68,"407":68,"408":2,"416":81,"420":30,"421":144,"424":30,"426":68,"427":30,"429":18,"439":66,"441":101,"442":30,"443":30,"446":30,"447":30,"454":144,"455":124,"459":160,"465":18,"466":18,"468":8,"472":66,"473":65,"474":66,"475":81,"476":66,"477":65,"478":65,"479":65,"480":30,"485":169,"501":81,"509":23,"517":8,"518":18,"521":8,"525":18,"529":68,"531":66,"532":81,"534":66,"543":47,"552":30,"555":18,"556":18,"559":66,"561":170,"578":144,"580":169,"581":169,"582":169,"583":169,"585":30};

// Owner rule per do-func: which lists land in the owner's own state list.
//   65 aura (0x6FCBA8D0): aurastat + passivestat (PD2 NOPs the stock passivestate gate at 0x6FCBAA75)
//   66/81 offensive auras, 47 Cloak, 23 Energy Shield/Blaze: passivestat only (aurastats go to enemies)
//   18 self buffs (0x6FC628F0): aurastat + passivestat
//   68 warcries (PD 0x102C9F00), 25 Enchant (PD 0x102F98D0), 116 wereforms, 120 Feral Rage/Maul, 9 Frenzy/Berserk: aurastat
//   82 Redemption: nothing
const OWNER = { 65: ['aura', 'passive'], 18: ['aura', 'passive'], 66: ['passive'], 81: ['passive'], 47: ['passive'],
  23: ['passive'], 68: ['aura'], 25: ['aura'], 116: ['aura'], 120: ['aura'], 9: ['aura'], 82: [] };
// What other units get: 65/68/25 -> aurastats to allies; 66/81/47 -> aurastats to enemies; 18/23/116/120/9 -> nobody.
const TARGET = { 65: 'aura', 68: 'aura', 25: 'aura', 66: 'aura', 81: 'aura', 47: 'aura' };

function skillId(sk, o) { const v = o && o.id != null ? o.id : (sk.id != null ? sk.id : (sk.Id != null ? sk.Id : sk['*Id'])); return v == null || v === '' ? null : +v; }
function doFunc(sk, o) {
  const v = (o && o.srvdofunc != null) ? o.srvdofunc : (sk.srvdofunc != null && sk.srvdofunc !== '' ? sk.srvdofunc : sk.do);
  if (v != null && v !== '') return +v;
  const id = skillId(sk, o); return id != null && DOFUNC[id] != null ? DOFUNC[id] : null;
}
function columns(sk, which) {   // 0-based indices of filled stat columns
  const out = [];
  if (which === 'aura') {
    if (Array.isArray(sk.as)) sk.as.forEach((c, i) => { if (c[0] >= 0) out.push(i); });
    else for (let k = 1; k <= 6; k++) if (sk['aurastat' + k]) out.push(k - 1);
  } else {
    if (Array.isArray(sk.ps)) sk.ps.forEach((c, i) => { if (c[0] >= 0) out.push(i); });
    else for (let k = 1; k <= 5; k++) if (sk['passivestat' + k]) out.push(k - 1);
  }
  return out;
}
function ownerKinds(sk, opts) {
  const o = opts || {};
  let f = doFunc(sk, o);
  if (f == null) f = (o.isAura || +sk.aura === 1) ? 65 : 18;          // unknown: treat like the generic aura / self buff
  let kinds = OWNER[f];
  if (!kinds) kinds = ['aura'];                                       // other state do-funcs use AuraStatsToList 0x6FC648E0
  if (f === 65 && o.ownerMana != null && !(o.ownerMana > 0)) kinds = kinds.filter(k => k !== 'passive'); // mana > cost gate
  return kinds;
}

function selfBuffStats(skill, lvl, blvl, opts) {
  // lvl/blvl are accepted for API symmetry: the column choice does not depend on them (calcs do).
  const res = [];
  for (const which of ownerKinds(skill, opts)) {
    let cols = columns(skill, which);
    if (which === 'aura' && doFunc(skill, opts || {}) === 25 && !Array.isArray(skill.as)) {   // PD Enchant stops at first empty column
      const stop = cols.findIndex((c, i) => c !== i); if (stop >= 0) cols = cols.slice(0, stop);
    }
    for (const index of cols) res.push({ which, index });
  }
  return res;
}
function affectsSelf(skill, opts) { return selfBuffStats(skill, 0, 0, opts).length > 0; }
function targetStats(skill, opts) { const f = doFunc(skill, opts || {}); return TARGET[f] || 'none'; }

const api = { selfBuffStats, affectsSelf, targetStats, DOFUNC, OWNER };
if (typeof module !== 'undefined') module.exports = api;
if (typeof window !== 'undefined') window.PD2Auras = api;
})(this);

/* ---- adv/re/charscreen.js ---- */
/* Character-screen numbers and the melee hit chance, as Diablo II 1.13c + ProjectDiablo.dll compute them.
   Every formula is transcribed from the disassembly; addresses and verification status are in charscreen.md.

   ctx (all functions):
     T(id)          unit total of stat id, as D2Common GetUnitStat(player,id,0) (#10973) returns it. NOTE: the game does NOT
                    pass an item's own op-13 percent (16 item_armor_percent, 17/18 item_max/mindamage_percent) to the
                    player when that item has a nonzero target stat (armor 31 / weapon 21-24,159,160): D2Common
                    0x6FD89DC8 case 13 (0x6FD89E5F). The ED lives only inside the item's 21-24. fromEngine() below corrects
                    engine.js totals, which add those stats a second time.
     cls            CharStats row, needs ToHitFactor (CharStats +0x3C).
     weapon         Weapons.txt row of the primary hand weapon (D2Common #10061), or null. Fields used (engine.js names in
                    brackets): StrBonus [sb], DexBonus [db], 2handed [h2], 1or2handed [h12], and isMissilePotion (type tpot).
     weaponT(id)    the weapon unit's OWN total of a stat (only 111 item_normaldamage is read from it). Default 0.
     twoHandGrip    true when D2Common #10051 (0x6FD6FB80) returns 2: the only item in the hands is 2handed, or a
                    Barbarian holds a 1or2handed item with the other hand empty. Default derived from weapon + otherHand.
     otherHand      true when the other hand holds anything (shield / second weapon). Only used to derive twoHandGrip.
     isBarbarian    class id 4. Only used to derive twoHandGrip.
     mastery        {ar, dmg}: PD2 0x102728B0 value of the selected skill's weapon mastery. PD2 reads stat 342 (AR) / 343 (dmg)
                    passive_mastery_melee_*, or 345 / 346 passive_mastery_throw_* when the weapon is throwable and the skill
                    is a throw skill; each summed over the stat's entries whose param (item type) the weapon matches (PD
                    0x102D30B0). Default {ar:0,dmg:0}.
     skill          selected skill: {toHit, edPct, flat, srcDam, minDmg, maxDmg}. toHit = D2Common #10653 =
                    ToHit + (lvl-1)*LevToHit (or ToHitCalc) when lvl > 0, else 0. edPct / flat = SkillDesc ddam calc1 / calc2
                    as the descdam handler passes them. srcDam = Skills.txt SrcDam (128 = 100%). minDmg/maxDmg = the skill's
                    own damage already >>8 (D2Common #10567/#10297 + elemental #10121/#11091). For the plain "Attack"
                    skill everything is 0 except srcDam 128 and toHit 0.
     holyShieldPct  Holy Shield's defense % (state 101 skill calc), default 0.
*/
(function (root) {
'use strict';
const tdiv = (a, b) => (b ? Math.trunc(a / b) : 0);
const mulDiv100 = (a, b) => tdiv(a * b, 100);   // exact for the ranges the character screen sees (the game has a 64-bit path)

function _ctx(ctx) {
  const w = ctx.weapon || null;
  const g = (o, a, b) => (o ? (o[a] !== undefined ? o[a] : (o[b] !== undefined ? o[b] : 0)) : 0);
  const two = ctx.twoHandGrip !== undefined ? !!ctx.twoHandGrip
    : !!(w && !ctx.otherHand && (g(w, '2handed', 'h2') || (ctx.isBarbarian && g(w, '1or2handed', 'h12'))));
  return {
    T: ctx.T, w, two,
    sb: g(w, 'StrBonus', 'sb'), db: g(w, 'DexBonus', 'db'),
    wT: ctx.weaponT || (() => 0),
    m: Object.assign({ ar: 0, dmg: 0 }, ctx.mastery || {}),
    sk: Object.assign({ toHit: 0, edPct: 0, flat: 0, srcDam: 128, minDmg: 0, maxDmg: 0 }, ctx.skill || {}),
  };
}

/* D2Common #10621 (0x6FD81EA0): player base attack rating. */
function baseAR(T, cls) { return T(19) + T(2) - 7 + 4 * T(2) - 28 + (cls ? cls.ToHitFactor : 0); }

/* Character screen attack rating for the selected skill (D2Client 0x6FADC4F0; "Attack" = SkillDesc descatt 2 ->
   0x6FAE0DB0 -> 0x6FADC4F0 for a single weapon). */
function attackRating(ctx) {
  const c = _ctx(ctx), T = c.T;
  let ar = baseAR(T, ctx.cls);
  if (c.w && c.w.isMissilePotion) return 0;                    // #11088 item type 38 (tpot) -> 0
  const pct = c.m.ar + T(119) + c.sk.toHit + (ctx.progressive ? T(325) : 0);
  return ar + mulDiv100(ar, pct);
}

/* D2Common #10672 (0x6FD82890): the defense the character screen shows (D2Client 0x6FB6D97B) and the hit roll uses. */
function defense(ctx) {
  const T = ctx.T;
  const base = T(31) + tdiv(T(2), 4);
  const pct = T(16) + T(171) + (ctx.holyShieldPct || 0);
  let def = base > 0 ? base + tdiv(base * pct, 100) : base - tdiv(base * pct, 100);
  const o = T(182);                                           // armor_override_percent
  if (o) def += tdiv(def * o, 100);
  return def;
}

/* Physical part: D2Client 0x6FAE1220. Returns {min,max} before elemental. srcOverride = the value the descdam handler
   passes (descdam 7 passes 128, so the SrcDam scaling happens later on the total). */
function physDamage(ctx, srcOverride) {
  const c = _ctx(ctx), T = c.T;
  let mn, mx;
  if (c.w) { if (c.two) { mn = T(23); mx = T(24); } else { mn = T(21); mx = T(22); } }
  else { mn = T(21) + 1; mx = T(22) + 2; }
  const src = srcOverride !== undefined ? srcOverride : c.sk.srcDam;
  let omin = 0, omax = 0;
  if (src !== 128) { mn = tdiv(mn * src, 128); mx = tdiv(mx * src, 128); }
  if (src !== 0) { omin = Math.max(mn, 1); omax = Math.max(mx, 2); }
  let pct = c.sk.edPct + T(25) + c.m.dmg + (ctx.progressiveDmgPct || 0);
  let normal = 0;
  if (c.w) {
    if (c.sb) pct += mulDiv100(T(0), c.sb);
    if (c.db) pct += mulDiv100(T(2), c.db);
    normal = c.wT(111);
  } else pct += T(0);
  if (pct < -90) pct = -90;
  return {
    min: tdiv((T(18) + pct + 100) * omin, 100) + normal + c.sk.flat,
    max: tdiv((T(17) + pct + 100) * omax, 100) + normal + c.sk.flat,
  };
}

/* Elemental + poison added on top: D2Client 0x6FAE0E30 (table 0x6FB869B4: {min,max,mastery}). Mutates acc. */
function addElemental(T, acc) {
  for (const [lo, hi, m] of [[48, 49, 329], [50, 51, 330], [54, 55, 331], [52, 53, -1]]) {
    let a = T(lo), b = T(hi);
    const mv = m >= 0 ? T(m) : 0;
    if (mv) { a += mulDiv100(a, mv); b += mulDiv100(b, mv); }
    if (a >= b) a = b;
    acc.min += a; acc.max += b;
  }
  let pmin = T(57), pmax = T(58);
  if (pmax) {
    const pm = T(332);
    if (pm) { pmin += mulDiv100(pmin, pm); pmax += mulDiv100(pmax, pm); }
    let len = T(101);
    if (!(len > 0)) len = tdiv(T(59), Math.max(T(326), 1));
    acc.min += (len * pmin) >> 8; acc.max += (len * pmax) >> 8;
  }
  if (acc.max > 0) { if (acc.min < 1) acc.min = 1; if (acc.max < acc.min + 1) acc.max = acc.min + 1; }
  return acc;
}

/* Character-screen damage for the selected skill with a single weapon (descdam 1 "Attack" -> 0x6FAE5470 -> descdam 7
   0x6FAE4C00 -> 0x6FAE3240 = 0x6FAE1220 + 0x6FAE0E30, then SrcDam scaling and the skill's own damage). */
function weaponDamage(ctx) {
  const c = _ctx(ctx);
  const acc = physDamage(ctx, 128);
  const phys = { min: acc.min, max: acc.max };
  addElemental(c.T, acc);
  const src = c.sk.srcDam;
  if (src !== 128) { acc.min = tdiv(acc.min * src, 128); acc.max = tdiv(acc.max * src, 128); }
  acc.min += c.sk.minDmg; acc.max += c.sk.maxDmg;
  return { min: acc.min, max: acc.max, phys };
}

/* Kick (descdam 2, D2Client 0x6FAE0AE0): (Skills MinDam << (HitShift-8)) + stat 137 item_kickdamage, shown as one number. */
function kickDamage(ctx, kickSkill) {
  const sk = kickSkill || { mind: 0, hs: 8 };
  return ((sk.mind || 0) << ((sk.hs === undefined ? 8 : sk.hs) - 8)) + ctx.T(137);
}

/* D2Game 0x6FCFDE90 hit roll (natively verified): chance in percent, 5..95. */
function hitChance(ar, alvl, def, dlvl) {
  if (def < 0) { ar -= def; def = 0; }
  if (ar < 0) { def -= ar; ar = 0; }
  const ratio = ar + def === 0 ? 100 : tdiv(ar * 100, ar + def);
  const ch = tdiv(ratio * alvl * 2, alvl + dlvl);
  return Math.min(95, Math.max(5, ch));
}

/* Server-side melee AR / defense of a player hitting a monster (D2Game 0x6FCFDE90 + 0x6FCFB1F0). mon = {def, lvl,
   demon, undead, boss, superunique, unique, champion, montype}. serverMastery = stock #10804 value (stat 342 for melee).
   attackVsMontype = stat 179 value whose param matches the monster. */
function meleeHitChance(ctx, mon, opts) {
  opts = opts || {}; const T = ctx.T;
  let ar = baseAR(T, ctx.cls);
  if (mon.demon) ar += T(123);
  if (mon.undead) ar += T(124);
  const pct = (opts.serverMastery || 0) + T(119) + ((ctx.skill && ctx.skill.toHit) || 0) + (opts.attackVsMontype || 0);
  ar += tdiv(ar * pct, 100);
  let def = mon.def + (mon.defBonus || 0);                     // + stat 33 armorclass_vs_hth of the monster, if any
  if (T(115) && !mon.superunique && !mon.unique && !mon.boss && !mon.merc) def = 0;
  if (T(116) > 0) {
    let v = T(116);
    if (mon.boss || mon.superunique || mon.merc || mon.player) v = tdiv(v, 2);
    if (v > 100) v = 100;
    def -= tdiv(def * v, 100);
  }
  return { ar, def, chance: hitChance(ar, ctx.clvl, def, mon.lvl) };
}

/* Build ctx from adv/engine/engine.js compute() output, correcting the op-13 double count (see header). */
function fromEngine(C, opts) {
  opts = opts || {};
  const D = C.D, W = C.weapons.weapons[0] || null;
  // Deterministic part of the op-13 rule: an item whose BASE list (set at creation, before affixes/sockets) has a
  // nonzero target keeps its percent: weapons with base damage keep 17/18, armor with base defense keeps 16.
  // Items that get 21/22 only from affixes or socketed jewels are order-dependent in the game (see charscreen.md);
  // they are passed through unchanged here.
  const consumed = { 16: 0, 17: 0, 18: 0 };
  let wList = null;
  for (const { it, T: L } of C.itemLists) {
    if (it === W) wList = L;
    const b = D.items[it.code]; if (!b) continue;
    if (b.c === 'weapon' && (b.min || b.max || b.min2 || b.max2 || b.tmin || b.tmax)) { consumed[17] += L.sum(17); consumed[18] += L.sum(18); }
    if (it.defense) consumed[16] += L.sum(16);
  }
  const T = id => (consumed[id] ? C.T(id) - consumed[id] : C.T(id));
  const b = W ? D.items[W.code] : null;
  const isType = (t, target) => { const seen = new Set(); const st = [t]; while (st.length) { const x = st.pop(); if (!x || seen.has(x)) continue; if (x === target) return true; seen.add(x); const r = D.types[x]; if (r) for (const e of (r.eq || r.equiv || [])) st.push(e); } return false; };
  const other = W ? [C.weapons.right, C.weapons.left].find(x => x && x !== W) : null;
  return {
    T, clvl: C.model.level, cls: C.cls,
    weapon: b ? { StrBonus: b.sb, DexBonus: b.db, '2handed': b.h2, '1or2handed': b.h12, isMissilePotion: isType(b.t, 'tpot') } : null,
    weaponT: id => (wList ? wList.sum(id) : 0),
    otherHand: !!other, isBarbarian: C.model.cls === 4,
    mastery: opts.mastery || { ar: 0, dmg: 0 }, skill: opts.skill || { srcDam: 128 },
  };
}

const API = { baseAR, attackRating, defense, physDamage, addElemental, weaponDamage, kickDamage, hitChance, meleeHitChance, fromEngine };
if (typeof module !== 'undefined' && module.exports) module.exports = API; else root.PD2CharScreen = API;
})(typeof window !== 'undefined' ? window : globalThis);

/* ---- adv/re/block_regen.js ---- */
/* Block chance, faster block rate, life/mana/stamina regeneration for Project Diablo 2 (1.13c + ProjectDiablo.dll).
   Every formula is taken from the disassembly; see block_regen.md for the addresses and verification status.

   ctx = {
     T(id)        unit total of a stat, as engine.js returns it (stat 7/9/11 are 8.8 fixed point, i.e. *256)
     cls          CharStats row: { BlockFactor, ManaRegen, RunDrain }   (PD2: ManaRegen 120 for every class)
     hasShield    true when an item of type 'shie' (ItemTypes 0x33 and its children), not broken, is in a hand slot
     expansion    game is expansion (default true; PD2 is always expansion)
     states       Set/array of active state names, e.g. 'holyshield' (state 101), 'nomanaregen' (state 85)
     pd2          true (default) = ProjectDiablo.dll behaviour; false = stock 1.13c D2Game
     mode         player mode number (0 DT, 1 NU, 2 WL, 3 RN, 4 GH, 5 TN, 6 TW, ... 9 BL)   optional
     attackerClass  MonStats id of the attacker (1112 = wraithMapMod divides block by 3 in PD2)  optional
     pvpMap       defender stands in PD2 level 157, 159 or 166 (PvP maps)  optional
     wclass       weapon class index for weapon block (5 = 2hs, 13 = ht2)  optional
   }
   Stat 20 (toblock) already contains the shield's own Armor.txt `block` (set on the item at creation). */
(function (root) {
'use strict';
const tdiv = (a, b) => { const q = Math.floor(Math.abs(a) / Math.abs(b)); return (a >= 0) === (b > 0) ? q : -q; };
const has = (ctx, s) => !!ctx.states && (ctx.states.has ? ctx.states.has(s) : ctx.states.includes(s));
const FPS = 25;

// ---- chance to block: D2Common #10212 (0x6FD81D20). The character panel shows this value (PD2 0x1021BD17).
function blockChance(ctx) {
  const T = ctx.T;
  if (!ctx.hasShield) return 0;                       // #10854 (0x6FD6FF40): a shield must be equipped
  let b = T(20) + (ctx.cls.BlockFactor | 0);
  if (ctx.expansion !== false) {
    const lvl = Math.max(1, T(12));
    b = tdiv((T(2) - 15) * b, 2 * lvl);
  }
  return Math.min(b, 75);                             // no lower clamp; <= 0 means no block
}
// ---- the chance actually rolled when the unit is hit (melee and missile)
// PD2: 0x1026FB60 (replaces the calls to stock 0x6FCFB790 at D2Game 0x6FCFE660 and 0x6FC5AF04)
function blockRollChance(ctx) {
  let b = blockChance(ctx);
  if (b < 1) return 0;
  if (ctx.pd2 !== false) {
    if (ctx.attackerClass === 1112) b = tdiv(b, 3);   // wraithMapMod
  } else {
    const m = ctx.mode;                                // stock: moving (#10143: mode 2/3/6) and not walking -> /3
    if ((m === 3 || m === 6)) b = tdiv(b, 3);
  }
  return b;                                            // blocked when (rng % 100) < b
}
// ---- weapon block (passive_weaponblock, stat 348): tried only when the shield chance is < 1
// PD2 0x1026FCF0 / 0x1026FC00; stock 0x6FCFB030 / 0x6FCFA540.
function weaponBlockChance(ctx, value348) {
  let w = value348 !== undefined ? value348 : ctx.T(348);   // game: largest value whose param matches an item type in hand
  if (w <= 0) return 0;
  if (ctx.pd2 !== false) {
    if (w > 75) w = 75;
    if (ctx.attackerClass === 1112) w = Math.floor(w / 3);
    if (ctx.wclass !== 5 && ctx.wclass !== 13) return 0;   // 2hs or two claws
    if (ctx.pvpMap) w = tdiv(w, 2);
    return w;
  }
  if (ctx.wclass !== 13) return 0;                    // stock: two claws only, no cap
  return w;
}

// ---- faster block rate: D2Common 0x6FD83110, block branch (player mode 9 / monster mode 6)
const efbr = fbr => fbr ? tdiv(120 * fbr, 120 + fbr) : 0; // 0x6FD823E0 table 0x6FDE4608 row {1,120,102}
function fbrBase(ctx) { return has(ctx, 'holyshield') ? 100 : 50; }   // state 101 (#10494 0x6FD87DB0)
function blockRate(ctx, animSpeed) {                  // value stored at unit+0x4C; NOTE: no 175 cap for block
  const s = fbrBase(ctx) + efbr(ctx.T(102));
  let r = Math.floor(((s * animSpeed) >>> 0) / 100);
  if (r < 1) r = 1; if (r > 0x7fff) r = 0x7fff;
  return r;
}
// anim = AnimData record {frames, speed} for <class>BL<wclass> (e.g. AMBL1HS {3, 88}); count as in the FBR tables
function blockFrames(ctx, anim) { return Math.ceil(anim.frames * 256 / blockRate(ctx, anim.speed)) - 1; }
const BLOCK_ANIM = {                                  // PD2 AnimData.d2 (same as 1.13c for these keys)
  AM: { hth: [3, 256], '1ht': [3, 256], '1hs': [3, 88] },
  SO: { any: [5, 256] }, NE: { any: [6, 256] }, DZ: { any: [6, 256] }, BA: { any: [4, 256] }, AI: { any: [3, 256] },
  PA: { any: [3, 256], '2hs': [3, 168] },
};

// ---- life regeneration: D2Game 0x6FC97CB0, run every frame from the unit timer 0x6FC99B10
// life += stat74 (8.8 fixed point) per frame, clamped to [1 life, max life]. PD2 0x102689B0: in PvP maps a
// value above 30 is replaced by the bloodwarp state's hpregen, or 30.
function lifeRegenPerFrame(ctx) {
  let v = ctx.T(74);
  if (ctx.pd2 !== false && ctx.pvpMap && v > 30) v = has(ctx, 'bloodwarp') && ctx.bloodwarpHpRegen !== undefined ? ctx.bloodwarpHpRegen : 30;
  return v;                                           // 1/256 life per frame
}
function lifeRegen(ctx) { return lifeRegenPerFrame(ctx) * FPS / 256; }      // life per second

// ---- mana regeneration: D2Game 0x6FC97950 (every frame)
function manaRegenPerFrame(ctx) {
  const T = ctx.T; let e = 0;
  if (!has(ctx, 'nomanaregen')) {                     // state 85
    const d = ((ctx.cls.ManaRegen | 0) & 0xff) * 25 || 7500;
    e = Math.max(1, tdiv(T(9), d));                   // T(9) = max mana * 256
    e = tdiv(e * (T(27) + 100), 100);                 // manarecoverybonus
  }
  return e + T(26);                                   // manarecovery (raw 1/256 per frame)
}
function manaRegen(ctx) { return manaRegenPerFrame(ctx) * FPS / 256; }      // mana per second
// ~ maxMana / ManaRegen * (1 + bonus/100) per second: with PD2 ManaRegen 120, a full bar takes 120 s at 0 bonus.

// ---- stamina: regen D2Game 0x6FC97A50, drain 0x6FC97BB0 (both per frame)
function staminaRegenPerFrame(ctx, mode, stamina) {
  const T = ctx.T; const bonus = T(28); const max = T(11);
  let sh = { 1: 8, 5: 8, 2: 9, 6: 9 }[mode];
  if (mode === 2 && stamina !== undefined && !(stamina & ~0xff)) return 0;   // walking with < 1 stamina: nothing
  if (sh === undefined) { if (bonus < 1000) return 0; sh = 8; }              // run, get-hit, attacks, ...
  let a = max >> sh;
  if (bonus) a += tdiv(a * bonus, 100);
  return a;                                            // capped at max stamina
}
function staminaRegen(ctx, mode) { return staminaRegenPerFrame(ctx, mode) * FPS / 256; }
function staminaDrainPerFrame(ctx, bodyArmorSpeed) {  // running (mode 3), not in town
  let d = (ctx.cls.RunDrain | 0) * 2;
  if (bodyArmorSpeed !== undefined) d *= tdiv(bodyArmorSpeed, 10) + 1;       // Armor.txt `speed` of the body armor
  const v = ctx.T(154);                                                        // item_staminadrainpct
  if (v) d -= tdiv(d * v, 100);
  return Math.max(d, 1);
}
function staminaDrain(ctx, bodyArmorSpeed) { return staminaDrainPerFrame(ctx, bodyArmorSpeed) * FPS / 256; }

const API = { tdiv, blockChance, blockRollChance, weaponBlockChance, efbr, fbrBase, blockRate, blockFrames, BLOCK_ANIM,
  lifeRegenPerFrame, lifeRegen, manaRegenPerFrame, manaRegen, staminaRegenPerFrame, staminaRegen, staminaDrainPerFrame, staminaDrain };
if (typeof module !== 'undefined' && module.exports) module.exports = API; else root.PD2BlockRegen = API;
})(typeof window !== 'undefined' ? window : globalThis);

/* ---- adv/re/mf_misc.js ---- */
/* Magic find, gold find, experience bonus and walk/run speed for Project Diablo 2 (1.13c + ProjectDiablo.dll),
   reverse-engineered from the game binaries. See mf_misc.md for addresses and the verification status.
   All integer division is C-style truncation toward zero (tdiv). */
'use strict';

const tdiv = (a, b) => Math.trunc(a / b);

/* ---------------------------------------------------------------- 1. Magic find ------------------------------ */

/* D2Game 0x6FC2E130, called with x = 100 + mf and factor f:
     x <= 110 -> x (no diminishing for mf <= 10, including negative mf)
     else     -> tdiv((x-100)*f, (x-100)+f) + 100                                                            */
function diminishedMF(mf, f) {
  if (mf <= 10) return mf;
  return tdiv(mf * f, mf + f);
}

/* Effective MF per quality check, as used by the quality roll D2Game 0x6FC2FC40. PD2 does not patch this code. */
function effectiveMF(mf) {
  return {
    unique: diminishedMF(mf, 250),
    set: diminishedMF(mf, 500),
    rare: diminishedMF(mf, 600),
    magic: mf,               // magic uses 100+mf directly (idiv by 100+mf), no diminishing
  };
}

/* ItemRatio.txt from PD2 data.zip (identical in itemratio.bin). The game uses the row with the highest
   Version <= 100 matching (Uber, Class Specific), i.e. always the Version 1 rows below.
   Uber = item base is exceptional/elite (Items code != normcode); Class Specific = ItemTypes.Class set. */
const ITEM_RATIO = {
  //                  Unique        Rare         Set          Magic        HiQ     Normal
  normal:        { u: [400, 1, 6400], r: [100, 2, 3200], s: [160, 2, 5600], m: [34, 3, 192], hq: [12, 8], n: [2, 2] },
  uber:          { u: [400, 1, 6400], r: [100, 2, 3200], s: [160, 2, 5600], m: [34, 3, 192], hq: [12, 8], n: [1, 1] },
  classSpecific: { u: [240, 3, 6400], r: [80, 3, 3200],  s: [120, 3, 5600], m: [17, 6, 192], hq: [9, 8],  n: [2, 2] },
  classUber:     { u: [240, 3, 6400], r: [80, 3, 3200],  s: [120, 3, 5600], m: [17, 6, 192], hq: [9, 8],  n: [1, 1] },
};

/* One quality check's "chance" denominator (success = rand(c) < 128, i.e. p = min(1, 128/c); c <= 0 -> success).
   base/div/min from ItemRatio; tc = TreasureClassEx quality value (0..1024) for that quality (max along the TC chain). */
function qualityDenominator(base, div, min, ilvl, qlvl, mfDiv /* 100+effMF or null when mf==0 */, tc) {
  let c = (base - tdiv(ilvl - qlvl, div)) * 128;
  if (mfDiv) c = tdiv(c * 100, mfDiv);
  if (c < min) c = min;
  c -= (c * tc) >> 10;                 // compiled as signed /1024 toward zero; c*tc >= 0 in practice
  return c;
}
const passChance = c => (c <= 128 ? 1 : 128 / c);

/* Probability of each quality for one item drop (D2Game 0x6FC2FC40). Order: unique, set, rare, magic, superior,
   normal, low. Items whose ItemTypes flags force a quality (Normal/Magic columns, quest items, TC-forced
   unique/set) skip parts of this; the "no unique/set available -> downgrade" step happens later and is not modelled.
   opts: { ilvl, qlvl, mf, ratio: ITEM_RATIO.normal, tc: {unique,set,rare,magic}, rareAllowed: true }            */
function qualityChances({ ilvl, qlvl, mf = 0, ratio = ITEM_RATIO.normal, tc = {}, rareAllowed = true }) {
  const e = effectiveMF(mf), has = mf !== 0, out = {};
  let left = 1;
  const take = (name, c) => { const p = passChance(c); out[name] = left * p; left *= 1 - p; };
  if (!(has && mf <= -100)) {          // mf <= -100 skips straight to the superior check
    take('unique', qualityDenominator(...ratio.u, ilvl, qlvl, has ? 100 + e.unique : null, tc.unique || 0));
    take('set',    qualityDenominator(...ratio.s, ilvl, qlvl, has ? 100 + e.set : null,    tc.set || 0));
    if (rareAllowed) take('rare', qualityDenominator(...ratio.r, ilvl, qlvl, has ? 100 + e.rare : null, tc.rare || 0));
    take('magic',  qualityDenominator(...ratio.m, ilvl, qlvl, has ? 100 + e.magic : null,  tc.magic || 0));
  }
  take('superior', (ratio.hq[0] - tdiv(ilvl - qlvl, ratio.hq[1])) * 128);
  const cn = (ratio.n[0] - tdiv(ilvl - qlvl, ratio.n[1])) * 128;
  out.normal = cn <= 0 ? left : left * passChance(cn);
  out.low = left - out.normal;
  return out;
}

/* ---------------------------------------------------------------- 2. Gold find ------------------------------- */

/* D2Game 0x6FC2F260 (only for items of ItemTypes row 4 "gold"):
   gf = stat79(killer) [+ stat79(killer's owner, when the killer is an owned monster)]
   gold' = max(0, tdiv(gold * (100 + gf), 100)). No upper cap on dropped piles (the MaxGold cap in that
   function applies only when the target unit is a player). PD2 does not patch it. */
function goldFind(gold, gf) {
  return Math.max(0, tdiv(gold * (100 + gf), 100));
}

/* ---------------------------------------------------------------- 3. Experience ------------------------------ */

/* D2Game 0x6FC214D0 MulDiv(a, b, c) = a*b/c with overflow guards (arguments as passed: a=eax, b=edx). */
function mulDiv(a, b, c) {
  if (c === 0) return 0;
  if (b > 0x100000) return c > (b >> 4) ? tdiv(a * b, c) : tdiv(b, c) * a;
  if (a > 0x10000) return c > (a >> 4) ? tdiv(a * b, c) : tdiv(a, c) * b;
  return tdiv(a * b, c);
}

/* stat 85 item_addexperience (D2Game 0x6FCFC080..0x6FCFC09C): exp += MulDiv(bonus, exp, 100), applied after the
   level-difference penalty and Experience.txt ExpRatio. PD2 does not change this step. */
function expBonus(exp, bonus) {
  return bonus ? exp + mulDiv(bonus, exp, 100) : exp;
}

const PEN_LE = [256, 256, 256, 256, 256, 256, 207, 159, 110, 61, 13]; // D2Game 0x6FD1A01C, monster level <= player
const PEN_GT = [256, 256, 256, 256, 256, 256, 225, 174, 92, 38, 5];   // D2Game 0x6FD1A048, monster level  > player

/* PD2 level-difference penalty (ProjectDiablo.dll 0x102CACF0, replaces stock 0x6FCFAA40 via the call at
   D2Game 0x6FCFC075). Same tables as stock; differences: player level 20..24 below the monster uses a formula;
   the scaling is done in double precision and truncated. */
function pdLevelPenalty(exp, plvl, mlvl) {
  let f;
  if (plvl < mlvl) {
    const d = Math.min(mlvl - plvl, 10);
    if (plvl > 19 && mlvl > 0) {
      if (plvl >= 25) return Math.min(Math.trunc(exp * plvl / mlvl), 0x7fffffff);
      f = Math.min(256, Math.max(13, tdiv(3 * plvl, plvl + 5 * d) * 256 - 64));
    } else f = PEN_GT[d];
  } else f = PEN_LE[Math.min(plvl - mlvl, 10)];
  return f === 256 ? exp : Math.trunc(exp * f / 256);
}

/* Full per-player exp gain from one kill share (D2Game 0x6FCFC030):
   exp capped at 0x7FFFFF; nothing at max level; penalty; ExpRatio (Experience.txt, /1024); stat 85 bonus. */
function expGain({ exp, plvl, mlvl, expRatio = 1024, bonus = 0 }) {
  exp = Math.min(exp, 0x7fffff);
  if (exp <= 0) return 0;
  exp = pdLevelPenalty(exp, plvl, mlvl);
  if (exp > 0) {
    const sh = 10;
    exp = exp > (0x7fffffff >> ((expRatio >> sh) + sh)) ? (exp >> sh) * expRatio : (expRatio * exp) >> sh;
  }
  return expBonus(exp, bonus);
}

/* ---------------------------------------------------------------- 4. Walk / run speed ------------------------ */

/* Diminishing table D2Common 0x6FDE4608 (EIAS helper 0x6FD823E0; PD2's replacement 0x10267DA0 reads the same table):
   E = tdiv(k*v, k+v). */
const DR = { ias: 120, fhr: 120, fcr: 120, fbr: 120, frw: 150 };
const eff = (k, v) => (v && k + v !== 0 ? tdiv(k * v, k + v) : 0);
const EFRW = frw => eff(150, frw);
const EFHR = fhr => eff(120, fhr);

/* Player walk/run velocity (D2Common 0x6FD83110 walk/run branch, 0x6FD8331B..0x6FD833CF):
     s   = max(25, velocitypercent + EFRW(frw))
     vel = tdiv((WalkVelocity << 8) * s, 100)          -> path velocity (path+0x7C)
   velocitypercent (stat 67) = 100 base (D2Game 0x6FC760D2)
                             + tdiv(RunVelocity*100, WalkVelocity) - 100 while running (= +50; D2Common 0x6FD82E10)
                             + armor/shield "speed" penalties (-Items.speed, D2Common 0x6FD7ADD9)
                             + skill/aura velocitypercent (Burst of Speed, Vigor, Feral Rage, slows ...).
   Movement per server frame = vel*16 / 65536 subtiles (D2Common 0x6FD5CEB0 with 0x400 from D2Game 0x6FD01960,
   unit direction vectors of length 4096), 25 frames/s.
   ctx: { frw, running=true, velocityPercent (extra stat 67, e.g. -5 for heavy armor, +skill), walkVelocity=6, runVelocity=9 } */
function runSpeed({ frw = 0, running = true, velocityPercent = 0, walkVelocity = 6, runVelocity = 9 } = {}) {
  const runBonus = running ? tdiv(runVelocity * 100, walkVelocity) - 100 : 0;
  const vp = 100 + runBonus + velocityPercent;
  const s = Math.max(25, vp + EFRW(frw));
  const vel = tdiv((walkVelocity << 8) * s, 100);
  const subtilesPerSecond = vel * 16 / 65536 * 25;
  return {
    efrw: EFRW(frw), speedPercent: s, pathVelocity: vel, subtilesPerSecond,
    percentOfBaseWalk: vel / (walkVelocity << 8) * 100,
    percentOfBaseRun: vel / tdiv((walkVelocity << 8) * (100 + (tdiv(runVelocity * 100, walkVelocity) - 100)), 100) * 100,
  };
}

/* 5. Hit recovery animation rate (D2Common 0x6FD83110): 50 + EFHR(fhr) (see FINDINGS.md "Attack speed"). */
const hitRecoveryRate = fhr => 50 + EFHR(fhr);

const api = { tdiv, diminishedMF, effectiveMF, ITEM_RATIO, qualityDenominator, qualityChances, goldFind, mulDiv,
  expBonus, pdLevelPenalty, expGain, DR, EFRW, EFHR, runSpeed, hitRecoveryRate };
if (typeof module !== 'undefined') module.exports = api;
if (typeof window !== 'undefined') window.PD2MfMisc = api;

/* ---- adv/re/damage.js ---- */
(function(){ var module = {exports: {}};
// Player -> monster damage in Project Diablo 2 (Diablo II 1.13c D2Game/D2Common + ProjectDiablo.dll).
// Every formula below was read from the disassembly; see damage.md for addresses and the
// VERIFIED / READ status of each one. Native checks: harness/damage.c + harness/damage_check.js.
//
// Units: the server keeps damage and life in 1/256 of a hit point ("<<8 units"). Functions that
// take or return damage use those units unless the parameter name ends in "Pts".
// Integer rounding follows the game: trunc() = C integer division (toward zero).
'use strict';

const trunc = Math.trunc;
const I32 = (x) => x | 0;

// ---------------------------------------------------------------------------------------------
// Integer helpers that reproduce the game's arithmetic exactly
// ---------------------------------------------------------------------------------------------

// D2Game 0x6FC214D0 "MulDiv"(a, b, c) = a*b/c with the game's large-value shortcuts.
function mulDiv(a, b, c) {
  a = I32(a); b = I32(b); c = I32(c);
  if (c === 0) return 0;
  if (b > 0x100000) {
    if (c <= (b >> 4)) return I32(Math.imul(trunc(b / c), a));
    return trunc(Number(BigInt(a) * BigInt(b) / BigInt(c)));
  }
  if (a > 0x10000) {
    if (c <= (a >> 4)) return I32(Math.imul(trunc(a / c), b));
    return trunc(Number(BigInt(a) * BigInt(b) / BigInt(c)));
  }
  return trunc(Math.imul(a, b) / c);
}

// The inline "v * pct / 100" used by the damage roll (0x6FCFBED0) and the stock resist step:
// for v > 0x100000 it computes trunc(v/100)*pct, for pct > 0x10000 trunc(pct/100)*v, else a
// 32-bit v*pct/100.
function pct100(v, pct) {
  v = I32(v); pct = I32(pct);
  if (v > 0x100000) return I32(Math.imul(trunc(v / 100), pct));
  if (pct > 0x10000) return I32(Math.imul(trunc(pct / 100), v));
  return trunc(Math.imul(v, pct) / 100);
}

// PD 0x102CE840: trunc(v * mult / div) in double precision, saturating at INT32_MAX.
function pdMulDiv(v, mult, div = 100) {
  const d = (div >>> 0) > 1 ? div : 1;
  const x = (v * mult) / d;
  return x > 2147483647 ? 2147483647 : trunc(x);
}

// Game RNG step (D2Game 0x6FC211D0) for tests: seed = {lo, hi}; returns [value, newSeed].
function gameRand(seed, n) {
  if (n <= 0) return [0, seed];
  const x = BigInt(seed.lo >>> 0) * 0x6AC690C5n + BigInt(seed.hi >>> 0);
  const lo = Number(x & 0xFFFFFFFFn), hi = Number((x >> 32n) & 0xFFFFFFFFn);
  const v = (n & (n - 1)) === 0 ? (lo & (n - 1)) >>> 0 : lo % n;
  return [v, { lo, hi }];
}

// ---------------------------------------------------------------------------------------------
// 1. Physical damage roll (stock D2Game 0x6FCFC530 + 0x6FCFBED0) - VERIFIED
// ---------------------------------------------------------------------------------------------
// p = {
//   weapon: bool            attacker holds a weapon in the attacking hand (0x6FC572C0 != 0)
//   twoHandGrip: bool       D2Common #10051 == 2 -> use 23/24 instead of 21/22
//   s21, s22, s23, s24      mindamage/maxdamage/secondary_min/max (player totals)
//   s111                    item_normaldamage (added before the percent, i.e. it IS multiplied)
//   s25                     damagepercent (item_damage_percent: "+X% damage", no min/max split)
//   s17, s18                maxdamage_percent / mindamage_percent (off-weapon ED, see charscreen.md)
//   str, dex, strBonus, dexBonus   Weapons.txt StrBonus/DexBonus of the weapon
//   mastery                 PD 0x102727D0 mode 1: stat 343 passive_mastery_melee_dmg or 346 (throw)
//   enDmgPct                damage+0x0C before the roll: skill ED% (D2Common #10786) +
//                           item_demondamage_percent(121) vs demons + 122 vs undead + montype bonus
//   base                    damage+0x08 before the roll (skill flat physical, <<8 units): NOT scaled by %
//   src                     Skills.txt SrcDam (128 = 100%)
// }
// rand(n) -> integer in [0, n). Returns physical damage in <<8 units (before crit/DS).
function physPercent(p) {
  let pct = (p.enDmgPct | 0) + (p.s25 | 0);
  if (p.weapon) {
    if (p.strBonus) pct += trunc((p.str | 0) * p.strBonus / 100);
    if (p.dexBonus) pct += trunc((p.dex | 0) * p.dexBonus / 100);
    pct += p.mastery | 0;
  } else {
    pct += p.str | 0;                 // unarmed: Str counts 1:1, no mastery
  }
  return Math.max(pct, -90);
}
function physBase(p) {
  let mn, mx;
  if (p.weapon) {
    [mn, mx] = p.twoHandGrip ? [p.s23 | 0, p.s24 | 0] : [p.s21 | 0, p.s22 | 0];
  } else {
    mn = (p.s21 | 0) > 0 ? p.s21 | 0 : 1;
    mx = (p.s22 | 0) > 1 ? p.s22 | 0 : 2;
  }
  mn <<= 8; mx <<= 8;
  const flat = (p.s111 | 0) << 8;
  mn += flat; mx += flat;
  if (mn < 1) mn = 256;
  if (mx <= mn) mx = mn + 256;
  return [mn, mx];
}
// 0x6FCFBED0: base + min' + rand(max'-min'), min' = min + min*minPct/100.
function rollRange(base, mn, mx, minPct, maxPct, rand) {
  if (mx <= 0) return Math.max(base, 0);
  const a = mn + pct100(mn, minPct);
  const b = mx + pct100(mx, maxPct);
  let r = base + a;
  if (b > a) r += rand(b - a);
  return Math.max(r, 0);
}
function srcScale(v, src) {
  if (src === 128 || src === undefined) return v;
  if (v > 0x100000) return Math.imul(trunc(v / 128), src);
  return trunc(Math.imul(v, src) / 128);
}
function physHit(p, rand = (n) => Math.floor(Math.random() * n)) {
  const [mn, mx] = physBase(p);
  const pct = physPercent(p);
  const v = rollRange(p.base | 0, mn, mx, (p.s18 | 0) + pct, (p.s17 | 0) + pct, rand);
  return srcScale(v, p.src === undefined ? 128 : p.src);
}
// Deterministic range (lowest and highest roll), in <<8 units and in points.
function physRange(p) {
  const lo = physHit(p, () => 0), hi = physHit(p, (n) => n - 1);
  return { min: lo, max: hi, minPts: lo / 256, maxPts: hi / 256 };
}

// ---------------------------------------------------------------------------------------------
// 2. Critical strike / deadly strike (PD 0x10270D20 + 0x10270E00; melee hook 0x6FCFD52C,
//    missile hook 0x6FC5A730 -> 0x10270C50) - VERIFIED
// ---------------------------------------------------------------------------------------------
// o = {
//   critChance  PD mastery mode 2 (stat 344 melee / 347 throw crit, weapon-type filtered)
//               + stat 337 passive_critical_strike + stat 258 item_crit_chance
//               (without a weapon only 337 + 258)
//   ds          stat 141 item_deadlystrike (includes 250 per-level via its op)
//   dsMaxBonus  stat 210 item_maxdeadlystrike (raises the 75 cap)
//   critMult    stat 256 item_crit_multiplier + its weapon-item-type-param entries (0x102D30B0)
//   dsMult      stat 257 item_ds_multiplier   + its item-type-param entries
// }
// Only ONE of the two can happen per hit: crit is rolled first, DS only if crit fails.
function critOutcome(o, roll1, roll2) {
  let r = roll1, used = 0;
  const c = o.critChance | 0;
  if (c > 0) {
    used = 1;
    if (Math.min(c, 75) > r) return { kind: 'crit', mult: 200 + (o.critMult | 0) };
    r = roll2;
  }
  const cap = 75 + (o.dsMaxBonus | 0);
  const d = o.ds | 0;
  if (d > 0 && Math.min(d, cap) > r) return { kind: 'ds', mult: 150 + (o.dsMult | 0) };
  return { kind: 'none', mult: 100 };
}
function critMultiplier(o) {                 // expected multiplier on physical damage
  const c = Math.max(0, Math.min(o.critChance | 0, 75)) / 100;
  const d = Math.max(0, Math.min(o.ds | 0, 75 + (o.dsMaxBonus | 0))) / 100;
  const pc = c, pd = (1 - c) * Math.min(d, 1);
  return 1 + pc * (100 + (o.critMult | 0)) / 100 + pd * (50 + (o.dsMult | 0)) / 100;
}
function applyCrit(phys, outcome) {
  return outcome.mult === 100 ? phys : pdMulDiv(phys, outcome.mult, 100);
}

// ---------------------------------------------------------------------------------------------
// 3. Elemental damage from the attacker's stats (stock 0x6FCFCD80 -> 0x6FCFBED0) - VERIFIED via
//    the shared roll; and skill elemental (D2Common #11091/#10121 + PD 0x10268A50) - READ
// ---------------------------------------------------------------------------------------------
// Item/character elemental min/max (48/49 fire, 50/51 ltng, 54/55 cold, 52/53 magic) get the
// matching mastery (329/330/331/357) as a percent on both ends, then src/128.
// base = the skill's own elemental damage already in the damage struct (<<8), added unscaled.
function elemHit({ min, max, mastery = 0, base = 0, src = 128 }, rand = (n) => Math.floor(Math.random() * n)) {
  const mx = (max | 0) << 8;
  if (mx < 8) return Math.max(base, 0);
  const v = rollRange(base, (min | 0) << 8, mx, mastery, mastery, rand);
  return src === 128 ? v : trunc(Math.imul(v, src) / 128);
}
// Skill elemental (D2Common #11091 min / #10121 max): base<<HitShift, then synergy, then mastery,
// each step truncated. PD adds magic mastery 357 for EType 3 (0x10268A50).
function skillElem(baseShifted, synergyPct, masteryPct) {
  let v = baseShifted + mulDiv(baseShifted, synergyPct, 100);
  if (masteryPct) v += mulDiv(v, masteryPct, 100);
  return v;
}

// ---------------------------------------------------------------------------------------------
// 4. Resistance, damage reduction and absorb on the monster
//    (PD 0x1026F410 + 0x1026F680 + 0x1026EA70 + 0x1026F820) - VERIFIED
// ---------------------------------------------------------------------------------------------
// Monster resist stat after curses/auras: each negative contribution to 36,37,39,41,43,45 is
// halved when the monster's BASE value of that stat (#10587) is >= 100 (PD 0x102C0540; stock
// 0x6FC6E230 divides by 5). Positive contributions are unchanged.
function monsterResAfterCurses(baseRes, contributions = []) {
  let r = baseRes;
  for (const v of contributions) r += (v < 1 && baseRes > 99) ? trunc(v / 2) : v;
  return r;
}
// Effective resistance used in the damage formula.
//   res       the monster's total resist stat (36 phys, 37 magic, 39 fire, 41 ltng, 43 cold, 45 pois),
//             i.e. already including Conviction / Lower Resist / Amplify etc.
//   pierce    attacker's pierce: 425 phys, 333 fire, 334 ltng, 335 cold, 358 magic, 336 poison
//   opts.playerOwned  attacker is a player, or a unit whose owner is a player (merc, summon, missile)
//   opts.pvpMap       defender stands in level 157/159/166 (no pierce there)
function effectiveRes(res, pierce = 0, opts = {}) {
  const { playerOwned = true, pvpMap = false, defenderIsMonster = true } = opts;
  let r = res | 0;
  if (!pvpMap && (r < 100 || !defenderIsMonster)) {
    r -= pierce | 0;
    if (r < 0 && playerOwned) r = trunc(r / 2) | 0;    // PD: negative resistance counts half
  }
  if (r < 1) return Math.max(r, -100);                  // floor -100 (after halving)
  return r;                                             // monsters: no upper cap; >= 100 = immune
}
// Apply resist / DR / absorb to one damage value (<<8 units).
//   dr         flat reduction in <<8: phys = stat34<<8, elemental (fire/ltng/cold/magic) = stat35<<8
//              (x damage+0x54/1024 when that field is set, e.g. missiles with damage_framerate)
//   bypass     skill_bypass_undead/demons/beasts matched: positive resist and DR/absorb ignored
//   absorbPct  142/144/148/146 (cap 40), absorbFlat 143/145/149/147 (whole points)
function applyResist(v, res, { dr = 0, bypass = false, absorbPct = 0, absorbFlat = 0 } = {}) {
  if (v < 1) return 0;
  if (!bypass) {
    v = Math.max(v - dr, 0);
    if (v <= 0) return 0;
  } else if (res > 0) {
    return v;
  }
  if (res !== 0) v = pdMulDiv(v, 100 - (res > 99 ? 100 : res), 100);
  if (bypass) return v;
  if (v > 0) {
    const ap = Math.min(absorbPct | 0, 40);
    if (ap > 0) v -= pdMulDiv(v, ap, 100);
    const af = (absorbFlat | 0) << 8;
    if (af > 0) v -= Math.min(v, af);
  }
  return Math.max(v, 0);
}
// Convenience: dmg x (100 - effRes)/100 in whole points.
function elemAfterRes(dmg, monRes, pierce = 0, opts = {}) {
  const r = effectiveRes(monRes, pierce, opts);
  return applyResist(Math.round(dmg * 256), r, opts) / 256;
}

// ---------------------------------------------------------------------------------------------
// 5. Crushing blow (PD item-event 16 = 0x102AF610) - VERIFIED
// ---------------------------------------------------------------------------------------------
// o = {
//   life        defender's current life (<<8) at the moment the melee/missile damage event fires
//   maxLife     for hpPct of prime-evil bosses (<<8)
//   kind        'monster' | 'merc' | 'player'
//   primeEvil   MonStats primeevil flag (Mephisto, Diablo, Baal, ubers, many PD2 map bosses)
//   mapBoss     class is in PD's special list (0x102C7C00)
//   playerCount stat 100 monster_playercount (>= 1)
//   eff         stat 268 item_crushingblow_efficiency (+ its item-type-param entries)
//   smitePct    Smite's CB calc (skills.txt +0x144), 0 otherwise
//   missile     damage came from a missile (event domissiledamage)
//   physRes     defender stat 36 (no pierce is applied to CB)
// }
// Chance: stat 136 (+ item-type-param entries, + Smite calc) vs rand(100).
const PD_PLAYERCOUNT_HP = [0, 0, 70, 140, 210, 280, 350, 420, 490];   // D2Game 0x6FD1B614 as PD patches it
function playerCountHpBonus(n) { n = Math.max(n | 0, 1); return n < 9 ? PD_PLAYERCOUNT_HP[n] : (n - 2) * 50; }
function crushingBlowDivisor(o) {
  let div = 8;
  if (o.kind === 'player' || o.kind === 'merc') div = 10;
  else {
    if (o.primeEvil) {
      if (o.mapBoss) div = 30;
      else {
        const hpPct = o.hpPct !== undefined ? o.hpPct
          : ((o.maxLife >> 8) ? trunc((o.life >> 8) * 100 / (o.maxLife >> 8)) : 0);
        div = (100 - hpPct) * 10 + 70;
      }
    }
    const bonus = playerCountHpBonus(o.playerCount === undefined ? 1 : o.playerCount);
    if (bonus !== 0) div += bonus / 50;
  }
  if (o.missile) div *= 1.5;
  return div;
}
// Returns { newLife, removed } in <<8 units (newLife 0 = killed). No effect if physRes >= 100.
function crushingBlow(o) {
  const life = o.life;
  const res = o.physRes | 0;
  if (res >= 100) return { newLife: life, removed: 0 };
  const factor = (o.eff | 0) / 100 + 1 + (o.smitePct || 0) / 100;
  const cb = life / (crushingBlowDivisor(o) / factor);
  const cut = pdMulDiv(trunc(cb), res, 100);
  const after = cb - cut;
  let nl = trunc(life - after);
  if (nl < 1) nl = 0;
  return { newLife: nl, removed: life - nl };
}

// ---------------------------------------------------------------------------------------------
// 6. Open wounds (PD item-event 15 = 0x102AF060) - VERIFIED (damage value)
// ---------------------------------------------------------------------------------------------
// D2Game 0x6FCCC940 level table with slopes {9,18,27,36,45} per level band.
function levelScale(t, lvl) {
  if (lvl <= 1) return 0;
  if (lvl <= 15) return (lvl - 1) * t[0];
  if (lvl <= 30) return 14 * t[0] + (lvl - 15) * t[1];
  if (lvl <= 45) return 14 * t[0] + 15 * t[1] + (lvl - 30) * t[2];
  if (lvl <= 60) return 14 * t[0] + 15 * (t[1] + t[2]) + (lvl - 45) * t[3];
  return 14 * t[0] + 15 * (t[1] + t[2] + t[3]) + (lvl - 60) * t[4];
}
// o = { clvl, deepWounds (stat 501), physRes (defender 36), physPierce (attacker 425),
//       defenderOwnedByPlayer (merc/summon target: /4) }
// Returns the hpregen drain written to the OW state: per frame the monster loses value/256 life
// for 125 frames (5 s); up to 3 stacks add their values (openwounds_stack 189).
function openWounds(o) {
  const lvl = (o.clvl | 0) < 2 ? 1 : o.clvl | 0;
  let dmg = levelScale([9, 18, 27, 36, 45], lvl) + 25 + 5 * (o.deepWounds | 0);
  let r = (o.physRes | 0) < 100 ? (o.physRes | 0) - (o.physPierce | 0) : 100;
  if (r < 0) r = trunc(r / 2);
  dmg = pdMulDiv(dmg, 100 - r, 100);
  if (o.defenderOwnedByPlayer) dmg = trunc(dmg / 4);
  return { perFrame256: dmg, perSecondPts: dmg * 25 / 256, totalPts: dmg * 125 / 256 };
}

// ---------------------------------------------------------------------------------------------
// 7. Life / mana leech (PD 0x102700F0 -> stock 0x6FCFBA40; heal cap PD 0x10268600) - VERIFIED
// ---------------------------------------------------------------------------------------------
// phys: physical damage actually dealt (<<8): after crit, resist/DR/absorb and clamped to the
//       monster's remaining life (0x6FCFE1FB). Elemental damage never leeches.
// o = { lifeSteal (60), manaSteal (62), drain (MonStats Drain/Drain(N)/Drain(H) for this
//       difficulty; 0 or blank = no leech; players/non-monsters use 100),
//       lsDiv, msDiv (DifficultyLevels LifeStealDivisor/ManaStealDivisor: PD2 1/2/3),
//       missile (halves both), pvpMap }
// Returns gains in <<8 units.
function leech(phys, o) {
  if (o.pvpMap) return { life: 0, mana: 0 };
  let L = o.lifeSteal | 0, M = o.manaSteal | 0;
  if (o.missile) { L = (L >>> 1) | 0; M = (M >>> 1) | 0; }
  if (!L && !M) return { life: 0, mana: 0 };
  const drain = o.drain === undefined ? 100 : o.drain | 0;
  if (drain <= 0) return { life: 0, mana: 0 };
  L = L << 6; M = M << 6;
  if (o.player !== false) {
    if (o.lsDiv) L = trunc(L / o.lsDiv);
    if (o.msDiv) M = trunc(M / o.msDiv);
  }
  if (phys <= 0) return { life: 0, mana: 0 };
  const one = (X) => {
    if (!X) return 0;
    let g = mulDiv(X, phys, 100);
    if (drain !== 100) g = mulDiv(drain, g, 100);
    return trunc(g / 64);
  };
  return { mana: one(M), life: one(L) };
}
// PD 0x10268600 (hook on the leech heal's SetStat(life)): stat 488 lifedrain_percentcap.
// Healing is refused when BOTH the old and the new life are >= (100-cap)% of max life.
function leechHealAllowed(curLife, newLife, maxLife, cap488 = 0) {
  const t = (100 - cap488) / 100, m = maxLife ? maxLife : 1;
  if (newLife / m < t) return true;
  return !(curLife / m >= t);
}

// ---------------------------------------------------------------------------------------------
// 8. Marginal value of +1% skill damage vs -1% enemy resistance
// ---------------------------------------------------------------------------------------------
// d(final)/d(skill%)  : final = B * (1 + S/100) * (1 + M/100) * (100 - r)/100
// d(final)/d(-res%)   : 1 point of the monster's pre-pierce resist changes r by 1 while r > 0,
//                       by 1/2 once res - pierce < 0 (PD halving), and by 0 at the -100 floor
//                       or when the monster is immune (res >= 100: pierce ignored; curses halved).
function resistSlope(res, pierce, opts = {}) {
  const a = effectiveRes(res, pierce, opts), b = effectiveRes(res - 2, pierce, opts);
  return (a - b) / 2;                                   // effective points per point of -res
}
function damageFactor(res, pierce = 0, opts = {}) { return (100 - Math.min(effectiveRes(res, pierce, opts), 100)) / 100; }

module.exports = {
  mulDiv, pct100, pdMulDiv, gameRand, srcScale,
  physBase, physPercent, rollRange, physHit, physRange,
  critOutcome, critMultiplier, applyCrit,
  elemHit, skillElem,
  monsterResAfterCurses, effectiveRes, applyResist, elemAfterRes,
  PD_PLAYERCOUNT_HP, playerCountHpBonus, crushingBlowDivisor, crushingBlow,
  levelScale, openWounds,
  leech, leechHealAllowed,
  resistSlope, damageFactor,
};

window.PD2Damage = module.exports; })();
/* ---- adv/re/defense.js ---- */
/* Damage a PLAYER takes, monster attack rating / defense / damage, and the monster hit chance, for Project Diablo 2
   (Diablo II 1.13c D2Game/D2Common + ProjectDiablo.dll). Every formula is transcribed from the disassembly; the
   addresses and the verification status (VERIFIED = the game's own code was run natively and matched this file on
   every case; READ = read from disassembly only) are in defense.md.

   Units. The game keeps damage and life in 8.8 fixed point (x256). Functions whose names end in 8 take / return
   those raw values; the others take whole points. Stat values are the unit's totals (D2Common #10973), e.g. the
   player's stat 39 fireresist is the sum of gear + skills + the difficulty penalty NOT included (the game adds the
   penalty itself, see effectiveResist).

   Player (defender) description used by the damage functions:
     S         stats object {id: value} or a function id -> value. Ids used:
               34 normal_damage_reduction (flat DR, points)      35 magic_damage_reduction (MDR, points)
               36 damageresist (% DR)                              37 magicresist, 38 maxmagicresist
               39/40 fire res/max, 41/42 light, 43/44 cold, 45/46 poison, 110 item_poisonlengthresist
               142/143 fire absorb %/flat, 144/145 light, 146/147 magic, 148/149 cold
               114 item_damagetomana, 327 damage_framerate (of the attacking missile, see opts)
     opts.difficulty  0 normal, 1 nightmare, 2 hell (DifficultyLevels ResistPenalty 0 / -40 / -100)
     opts.pvp         defender stands in a PD2 PvP level (157, 159, 166): changes caps, no penalty, no pierce/absorb
     opts.stock       true = stock 1.13c code (ProjectDiablo.dll not loaded) - for comparison only
     opts.attackerPierce {333: fire, 334: light, 335: cold, 336: poison} pierce stats on the attacker (monsters: 0)
     opts.bypass      damage flag 0x400 ("ignore resistances/absorb"): positive resist ignored, no flat DR, no absorb
*/
(function (root) {
'use strict';
const tdiv = (a, b) => (b ? Math.trunc(a / b) : 0);
const sv = (S, id) => (id < 0 ? 0 : (typeof S === 'function' ? (S(id) | 0) : ((S && S[id]) | 0)));

/* ---------------------------------------------------------------------------------------------------------------
   Damage-type table: D2Game 0x6FD22AB0, 12 records of 0x2C bytes, walked in this order by D2Game 0x6FCFC0B0.
   off = byte offset in the damage struct, res/max/pierce/absPct/absFlat = stat ids (-1 none),
   flat: 0 none, 1 = stat 34 (DR), 2 = stat 35 (MDR); pvpPct: z flag (PvP / damage-percent scaling applies). */
const TYPES = [
  { name: 'Dam',  key: 'phys',   off: 0x08, res: 36,  max: -1, pierce: -1,  absPct: -1,  absFlat: -1,  flat: 1 },
  { name: 'Fire', key: 'fire',   off: 0x10, res: 39,  max: 40, pierce: 333, absPct: 142, absFlat: 143, flat: 2 },
  { name: 'Ligt', key: 'light',  off: 0x1C, res: 41,  max: 42, pierce: 334, absPct: 144, absFlat: 145, flat: 2 },
  { name: 'Cold', key: 'cold',   off: 0x24, res: 43,  max: 44, pierce: 335, absPct: 148, absFlat: 149, flat: 2 },
  { name: 'Magc', key: 'magic',  off: 0x20, res: 37,  max: 38, pierce: -1,  absPct: 146, absFlat: 147, flat: 2 },
  { name: 'CLen', key: 'coldLen',   off: 0x30, res: 43,  max: 44, pierce: 335, absPct: -1, absFlat: -1, flat: 0 },
  { name: 'FLen', key: 'freezeLen', off: 0x34, res: 43,  max: 44, pierce: 335, absPct: -1, absFlat: -1, flat: 0 },
  { name: 'PLen', key: 'poisonLen', off: 0x2C, res: 110, max: -1, pierce: 336, absPct: -1, absFlat: -1, flat: 0 },
  { name: 'Pois', key: 'poison', off: 0x28, res: 45,  max: 46, pierce: 336, absPct: -1,  absFlat: -1,  flat: 0 },
  { name: 'Life', key: 'lifeLeech', off: 0x38, res: -1, max: -1, pierce: -1, absPct: -1, absFlat: -1, flat: 0 },
  { name: 'Mana', key: 'manaLeech', off: 0x3C, res: -1, max: -1, pierce: -1, absPct: -1, absFlat: -1, flat: 0 },
  { name: 'Stam', key: 'stamLeech', off: 0x40, res: -1, max: -1, pierce: -1, absPct: -1, absFlat: -1, flat: 0 },
];
const TYPE = Object.fromEntries(TYPES.map((t, i) => [t.key, i]));
const RESIST_PENALTY = [0, -40, -100];         // DifficultyLevels.txt ResistPenalty (PD2 = vanilla values)

/* D2Game 0x6FC214D0: stock a*b/c with its overflow shortcuts (eax=a, edx=b, ecx=c). */
function muldiv(a, b, c) {
  a |= 0; b |= 0; c |= 0;
  if (!c) return 0;
  const big = () => Number((BigInt(a) * BigInt(b)) / BigInt(c));        // 64-bit path (0x6FD144B0 truncates)
  if (b > 0x100000) return c <= (b >> 4) ? Math.imul(tdiv(b, c), a) : big();
  if (a > 0x10000) return c <= (a >> 4) ? Math.imul(tdiv(a, c), b) : big();
  return tdiv(Math.imul(a, b), c);
}
/* ProjectDiablo 0x102CE840: trunc(v * f / max(d,1)) in double precision, 0x7FFFFFFF when above INT_MAX. */
function pdMul(v, f, d) {
  const r = (v * f) / (d >>> 0 > 1 ? d >>> 0 : 1);
  return r > 2147483647 ? 0x7FFFFFFF : Math.trunc(r);
}

/* Effective resistance for one table row. PD2 0x1026F680 (replaces stock 0x6FCFB3C0 through the call 0x6FCFC4E9).
   o: {S (defender), difficulty, pvp, attackerPierce, stock, expansion(default true), defenderIsMonster}. */
function effectiveResist(t, o) {
  const T = typeof t === 'number' ? TYPES[t] : t, S = o.S, pd = !o.stock, exp = o.expansion !== false;
  const monDef = !!o.defenderIsMonster, pvp = pd && !!o.pvp, diff = o.difficulty | 0;
  let res = sv(S, T.res);
  if (T.pierce >= 0 && !pvp && (res < 100 || !monDef)) {
    const p = (o.attackerPierce && o.attackerPierce[T.pierce]) | 0;
    if (pd) { res -= p; if (res < 0 && o.attackerIsPlayerOwned) res = tdiv(res, 2); }   // PD 0x1026EA70
    else if (p) res -= p;
  }
  if (!monDef && T.res !== 36 && T.res !== 37) {
    if (exp) { if (!pvp) res += RESIST_PENALTY[diff] !== undefined ? RESIST_PENALTY[diff] : 0; }
    else if (diff === 1) res -= 20; else if (diff === 2 && !pvp) res -= 50;
  }
  if (res <= 0) return Math.max(res, -100);
  if (!monDef) {
    let cap;
    if (T.max < 0) cap = T.res === 36 ? 50 : 75;
    else {
      cap = 75 + sv(S, T.max);
      const hard = pd ? (pvp ? (diff === 0 ? 75 : 80) : 90) : 95;          // PD2: 90 (PvP 75/80); stock 95
      if (cap > hard) cap = hard;
    }
    if (res > cap) res = cap;
  } else if (pd && o.defenderOwnedByPlayer && res > 90) res = 90;
  return res;
}

/* One damage type. PD2 0x1026F410 (via 0x102ED620; replaces the stock call to 0x6FCFBD00 at 0x6FCFC4E9).
   dmg8 = the value in the damage struct (8.8). Returns {dmg8, absorbed8, res}. o as effectiveResist plus
   o.S (defender stats), o.bypass, o.framerate (attacking missile's stat 327; 0 = full DR). */
function applyType8(t, dmg8, o) {
  const T = typeof t === 'number' ? TYPES[t] : t, S = o.S;
  let d = dmg8 | 0, absorbed = 0;
  if (o.stock) return stockApplyType8(T, d, o);
  if (d < 1) return { dmg8: 0, absorbed8: 0, res: 0 };
  const res = effectiveResist(T, o);
  const mulRes = (x) => (res ? pdMul(x, 100 - (res > 99 ? 100 : res), 100) : x);
  if (!o.bypass) {
    let flat = flatReduction8(T, o);
    if (flat > 0x1900 && o.pvp) flat = 0x1900;                              // PvP: flat DR/MDR capped at 25 points
    d = d - flat; if (d < 0) d = 0;
    if (d > 0) d = mulRes(d);
    // absorb: PD 0x1026F820
    if (d > 0 && T.absPct >= 0) {
      let p = sv(S, T.absPct); if (p > 40) p = 40;
      if (p > 0 && !o.pvp) { const a = pdMul(d, p, 100); absorbed += a; d -= a; }
      const f = sv(S, T.absFlat) << 8;
      if (f > 0 && !o.pvp) { const a = d > f ? f : d; absorbed += a; d -= a; }
    }
    if (d < 0) d = 0;
  } else if (res <= 0) d = mulRes(d);                                          // bypass: only negative resist
  return { dmg8: d, absorbed8: absorbed, res };
}
function flatReduction8(T, o) {
  if (!T.flat) return 0;
  let f = sv(o.S, T.flat === 1 ? 34 : 35) << 8;                                 // 0x6FCFC125 / 0x6FCFC14E
  if (f > 0 && o.framerate > 0) f = muldiv(o.framerate, f, 0x400);             // missile damage_framerate/1024
  return f;
}
/* Stock 1.13c 0x6FCFBD00 + 0x6FCFB3C0 + 0x6FCFAD00 (without ProjectDiablo.dll). Components can go negative. */
function stockApplyType8(T, d, o) {
  const S = o.S; let absorbed = 0;
  if (d <= 0) return { dmg8: 0, absorbed8: 0, res: 0 };
  let res = effectiveResist(T, o);
  if (o.bypass) { if (res > 0) res = 0; } else d -= flatReduction8(T, o);
  if (d > 0 && res) { const r = res >= 100 ? 100 : res; d = muldiv(100 - r, d, 100); }
  if (!o.bypass && T.absPct >= 0) {
    let p = sv(S, T.absPct);
    if (p >= 40) p = 40;
    if (p > 0) { const a = muldiv(p, d, 100); absorbed += a; d -= a; }
    const f = sv(S, T.absFlat) << 8;
    if (f > 0) { const a = f < d ? f : d; absorbed += a; d -= a; }
  }
  return { dmg8: d, absorbed8: absorbed, res };
}

/* A whole hit on a player (D2Game 0x6FCFC0B0 then 0x6FCFE0C0). hit8 = {phys, fire, light, cold, magic, poison,
   coldLen, freezeLen, poisonLen} in 8.8 (poison = damage per frame, lengths in frames).
   Returns per-type results, total8 (what life loses), absorbed8 (healed back before the subtraction, capped at max
   life), manaGain8 (damage-to-mana, stat 114, on the total) and killsFrom(life8). */
function applyHit8(hit8, o) {
  const out = { types: {}, total8: 0, absorbed8: 0 };
  for (let i = 0; i < 9; i++) {
    const T = TYPES[i], v = hit8[T.key] | 0;
    if (!v) { out.types[T.key] = { dmg8: 0, absorbed8: 0, res: 0 }; continue; }
    const r = applyType8(T, v, o); out.types[T.key] = r; out.absorbed8 += r.absorbed8;
  }
  const g = (k) => out.types[k].dmg8;
  out.total8 = g('cold') + g('poison') + g('magic') + g('light') + g('fire') + g('phys');   // 0x6FCFC4F7
  const dtm = sv(o.S, 114);                                                     // event func 13 (0x6FCCCDA0)
  out.manaGain8 = out.total8 > 0 && dtm > 0 ? muldiv(dtm, out.total8, 100) : 0;
  return out;
}
/* Death test of 0x6FCFE242: life8 - total8 < 256 -> life set to 0. (Absorb heals first, capped at max life.) */
function killsFrom(life8, total8, absorbed8, maxLife8) {
  const healed = Math.min(life8 + (absorbed8 | 0), maxLife8 === undefined ? life8 : maxLife8);
  return total8 > 0 && healed - total8 < 256;
}

/* ------------------- effective life: the smallest raw damage of one type that kills from full life ----------------
   Monotone in raw damage, so a binary search over the exact per-type function is exact (includes rounding). */
function rawToKill8(type, lifePoints, o) {
  const life8 = lifePoints * 256, i = typeof type === 'number' ? type : TYPE[type];
  const kills = (raw) => { const r = applyType8(i, raw, o); return killsFrom(life8, r.dmg8, 0, life8); };
  let lo = 0, hi = 256;
  while (!kills(hi)) { hi *= 2; if (hi > 2 ** 31) return Infinity; }
  while (hi - lo > 1) { const m = Math.floor((lo + hi) / 2); if (kills(m)) hi = m; else lo = m; }
  return hi;
}
/* Closed form of the same thing (points, ignoring the 1/256 truncations): damage passed = (raw - flat) * (1 - r) *
   (1 - a) - absFlat, kill when that >= L - 255/256. Returned as the raw points needed, for each damage type. */
function effectiveLife(lifePoints, o) {
  const res = {};
  for (const k of ['phys', 'fire', 'light', 'cold', 'magic']) {
    const T = TYPES[TYPE[k]];
    const r = Math.min(effectiveResist(T, o), 100);
    const flat = T.flat ? sv(o.S, T.flat === 1 ? 34 : 35) : 0;
    const a = T.absPct >= 0 ? Math.min(Math.max(sv(o.S, T.absPct), 0), 40) : 0;
    const af = T.absFlat >= 0 ? Math.max(sv(o.S, T.absFlat), 0) : 0;
    const need = lifePoints - 255 / 256;
    const mult = (1 - r / 100) * (1 - a / 100);
    res[k] = { resist: r, formula: `(raw - ${flat}) * ${(1 - r / 100).toFixed(2)} * ${(1 - a / 100).toFixed(2)} - ${af} >= L`,
      rawPoints: mult > 0 ? flat + (need + af) / mult : Infinity, exact8: rawToKill8(k, lifePoints, o) };
  }
  // poison: per-frame rate r8 over len frames; each frame is one hit through the same row (PD 0x10271A70 applies it)
  const pr = Math.min(effectiveResist(TYPES[TYPE.poison], o), 100);
  const plr = effectiveResist(TYPES[TYPE.poisonLen], o);
  res.poison = { resist: pr, lengthResist: plr,
    formula: 'total = rate*(100-res)/100 * len*(100-plr)/100 / 256 (points)',
    totalMultiplier: (1 - pr / 100) * (1 - Math.min(plr, 100) / 100) };
  return res;
}

/* --------------------------------------- the monster's hit roll against a player ------------------------------- */
/* D2Common #10672 (0x6FD82890) + stat 33 (melee) / 32 (missile) + stat 182 (hit roll 0x6FCFDE90). VERIFIED. */
function playerDefense(S, missile, holyShieldPct) {
  const base = sv(S, 31) + tdiv(sv(S, 2), 4);
  const pct = sv(S, 16) + sv(S, 171) + (holyShieldPct | 0);
  let def = base > 0 ? base + tdiv(base * pct, 100) : base - tdiv(base * pct, 100);
  def += sv(S, missile ? 32 : 33);
  const ov = sv(S, 182); if (ov) def += tdiv(def * ov, 100);
  return def;
}
/* D2Game 0x6FCFDE90 (VERIFIED): chance %, clamped 5..95. Monster attacker: AR already includes stat 119 via
   monsterAttackRating(); no target-specific adjustments. */
function hitChance(ar, alvl, def, dlvl) {
  if (def < 0) { ar -= def; def = 0; }
  if (ar < 0) { def -= ar; ar = 0; }
  const ratio = ar + def === 0 ? 100 : tdiv(ar * 100, ar + def);
  return Math.min(95, Math.max(5, tdiv(ratio * alvl * 2, alvl + dlvl)));
}

/* ----------------------------------------------- monsters ----------------------------------------------------
   DATA = monsters.json from extract_monsters.py: {monstats:{id:{...}}, monlvl:[[30 values],...], levels:{...},
   umod:{constants:[...]}, difficulty:[...] }. Load it with PD2Defense.setData(json). */
let DATA = null;
function setData(d) {
  DATA = d;
  if (!d.byIdx) { d.byIdx = {}; for (const k in d.monstats) d.byIdx[d.monstats[k].hcIdx] = d.monstats[k]; }
}

/* D2Common #11089 (0x6FDA4A00, VERIFIED natively with the real MonLvl.txt): value * MonLvl[col] / 100.
   col 'AC','TH','HP','DM','XP'; ladder = the L- columns (game-type byte != 0 or ladder game). */
const MLCOL = { AC: 0, TH: 6, HP: 12, DM: 18, XP: 24 };
function monLvl(col, diff, level, ladder) {
  const t = DATA.monlvl, lv = Math.max(0, Math.min(level, t.length - 1));
  return t[lv][MLCOL[col] + (ladder ? 3 : 0) + diff];
}
function scale(base, col, diff, level, ladder, noRatio) {
  return noRatio ? base : muldiv(base, monLvl(col, diff, level, ladder), 100);   // D2Common 0x6FD511E0 = muldiv
}

/* Player-count factors (D2Game tables 0x6FD1BBF0 / 0x6FD1B614): AR/damage x(1+f/128) in NM/Hell, HP x(1+hp/100). */
function playersAR(p, diff) { if (diff <= 0 || p < 2) return 0; return p < 9 ? [0, 0, 8, 16, 24, 32, 40, 48, 56][p] : 8 * p - 16; }
function playersHP(p) { p = Math.max(1, p); return p < 9 ? [0, 0, 50, 100, 150, 200, 250, 300, 350][p] : (p - 2) * 50; }
const scale128 = (x, f) => x + tdiv(x * f, 128);   // 0x6FC97482: (x*f + ((x*f>>31)&127)) >> 7

/* Monster level (spawn 0x6FCCFDB0 + PD2 0x10268D00 + MonUMod handlers):
   base = MonStats Level[diff] for Normal, noRatio or boss monsters; otherwise Levels.txt MonLvl{1,2,3}Ex[area].
   PD2: map levels (Levels id 137..201) add the map's map_glob_arealevel (ISC 374); in the rotating Hell zone set
   (game+0x26F2) the level is 85. kind: 'normal' | 'champion' (+2 = leveladd +3, champion -1) | 'unique' (+3) |
   'minion' (+3). Returns the level used for AR/damage (at attack time) and the spawn level used for HP/AC/XP. */
function monsterLevels(ms, diff, areaLevel, kind) {
  let spawn = (diff > 0 && !ms.noRatio && !ms.boss && areaLevel) ? areaLevel : ms.Level[diff];
  let add = kind === 'champion' ? 2 : (kind === 'unique' || kind === 'minion' || kind === 'superunique') ? 3 : 0;
  return { spawn, current: spawn + add };
}

/* monsterAt(monId, difficulty, level, kind, opts)
   monId      MonStats Id string (e.g. 'skeleton1') or hcIdx number
   difficulty 0/1/2
   level      area level (Levels MonLvlEx of the area, or map level); ignored for Normal/noRatio/boss (MonStats Level)
   kind       'normal' | 'champion' | 'unique' | 'minion' (default 'normal'); 'superunique' treated like unique
   opts       {players:1, ladder:false, attack:'A1'|'A2'|'S1', strong:false (unique/minion has the 'strong' umod),
               dmgPct/arPct: extra stat 25 damagepercent / stat 119 tohit% (not from MonStats; e.g. PD2 map mods)}
   Returns {lvl, spawnLvl, ar, arPct, def, dmgMin, dmgMax, dmgPct, elem:[...], life:{min,max}, res:{...}, xp}
   dmgMin/dmgMax are whole points AFTER the champion/unique damage% (stat 25) and player-count factor; ar includes
   stat 119 (tohit%) from the umods, i.e. the value that enters the hit roll. */
function monsterAt(monId, difficulty, level, kind, opts) {
  opts = opts || {}; kind = kind || 'normal';
  const d = Math.max(0, Math.min(2, difficulty | 0)), p = opts.players || 1, lad = !!opts.ladder;
  const ms = typeof monId === 'number' ? DATA.byIdx[monId] : DATA.monstats[monId];
  if (!ms) throw new Error('unknown monster ' + monId);
  const L = monsterLevels(ms, d, level, kind);
  const nr = !!ms.noRatio;
  const atk = opts.attack || 'A1';
  const th = ms[atk + 'TH'] ? ms[atk + 'TH'][d] : 0;
  const mn = ms[atk + 'MinD'] ? ms[atk + 'MinD'][d] : 0, mx = ms[atk + 'MaxD'] ? ms[atk + 'MaxD'][d] : 0;
  // attack-time values, D2Game 0x6FC97240, at the CURRENT level (includes +2/+3)
  let ar = scale(th, 'TH', d, L.current, lad, nr);
  let dmin = scale(mn, 'DM', d, L.current, lad, nr), dmax = scale(mx, 'DM', d, L.current, lad, nr);
  const f = playersAR(p, d);
  if (f) { ar = scale128(ar, f); dmin = scale128(dmin, f); dmax = scale128(dmax, f); }
  // umods (MonUMod constants; x ChampionDamageBonus/100 of DifficultyLevels): stat 25 / stat 119
  const C = DATA.umod.constants, cdb = DATA.difficulty[d].ChampionDamageBonus;
  let dmgPct = opts.dmgPct | 0, arPct = opts.arPct | 0;          // extra stat 25 / stat 119 (e.g. map mods), optional
  if (kind === 'champion') { dmgPct += tdiv(C[11] * cdb, 100); arPct += tdiv(C[10] * cdb, 100); }
  if (opts.strong) {                                    // 'strong' umod (5): unique vs minion constants
    if (kind === 'unique' || kind === 'superunique') { dmgPct += tdiv(C[15] * cdb, 100); arPct += tdiv(C[13] * cdb, 100); }
    else if (kind === 'minion') { dmgPct += tdiv(C[14] * cdb, 100); arPct += tdiv(C[12] * cdb, 100); }
  }
  const arHit = ar + tdiv(ar * arPct, 100);             // hit roll: AR += AR*stat119/100 (monster branch)
  // physical roll 0x6FCFC530: min>=1, max>=min+1, then x(100+pct)/100 on each end (8.8), pct >= -90
  let a = Math.max(dmin, 1) * 256, b = Math.max(dmax, 2) * 256; if (b <= a) b = a + 256;
  const pc = Math.max(dmgPct, -90);
  const lo8 = a + muldiv(a, pc, 100), hi8 = b + muldiv(b, pc, 100);
  // defense / life / xp at SPAWN level (0x6FCCFDB0), life x player count, x umod hp%
  const defv = scale(ms.AC[d], 'AC', d, L.spawn, lad, nr);
  let hpMin = scale(ms.MinHP[d], 'HP', d, L.spawn, lad, nr), hpMax = scale(ms.MaxHP[d], 'HP', d, L.spawn, lad, nr);
  const hpP = playersHP(p); hpMin += muldiv(hpP, hpMin, 100); hpMax += muldiv(hpP, hpMax, 100);
  let hpPct = 0;
  if (kind === 'champion') hpPct = C[4 + d]; else if (kind === 'unique' || kind === 'superunique') hpPct = C[7 + d];
  else if (kind === 'minion') hpPct = C[1 + d];
  if (hpPct) { hpMin += muldiv(hpMin, hpPct, 100); hpMax += muldiv(hpMax, hpPct, 100); }
  const elem = [];
  for (const e of ms.El || []) {
    if (!e.type || e.mode !== atk) continue;
    let emin = scale(e.min[d], 'DM', d, L.current, lad, nr), emax = scale(e.max[d], 'DM', d, L.current, lad, nr);
    let dur = e.dur[d];
    if (f) { emin = scale128(emin, f); emax = scale128(emax, f); dur = scale128(dur, f); }
    elem.push({ type: e.type, pct: e.pct[d], min: emin, max: emax, dur });
  }
  const R = (k) => ms[k] ? ms[k][d] : 0;
  return {
    id: ms.Id, lvl: L.current, spawnLvl: L.spawn, kind, ar: arHit, arBase: ar, arPct,
    def: defv, dmgMin: lo8 / 256, dmgMax: hi8 / 256, dmgPct, elem,
    life: { min: hpMin, max: hpMax }, xp: scale(ms.Exp[d], 'XP', d, L.spawn, lad, nr),
    res: { phys: R('ResDm'), magic: R('ResMa'), fire: R('ResFi'), light: R('ResLi'), cold: R('ResCo'), poison: R('ResPo') },
  };
}

/* Representative Hell monsters for "a typical monster at area level X". See defense.md for why these. */
/* Melee monsters that recur in the Hell nmon lists of areas with MonLvl3Ex >= 80 (Levels.txt), weakest to strongest
   A1 damage: Devilkin, Hungry Dead, Blood Clan, Preserved Dead, Steel Weevil, Unraveler, Ghoul Lord, Gorbelly,
   Doom Knight, Minion of Destruction, Blood Lord, Balrog. MAP_SET = PD2 map-only rows (Levels 137+). */
const HELL_SET = ['fallen3', 'zombie2', 'goatman3', 'mummy4', 'scarab4', 'unraveler3', 'vampire1', 'blunderbore2',
  'doomknight1', 'minion1', 'bloodlord1', 'megademon1'];
const MAP_SET = ['minionmap', 'goatmanmap', 'doomknightmap', 'zombieSiege', 'cr_archermap'];

/* Table rows for area level X in Hell. player = {S, clvl, missile}. Each row: monster, kind, lvl, ar, hit%, dmg range,
   expected damage per swing after the player's DR / %DR (phys only), and hits-to-kill for lifePoints. */
function typicalHellTable(areaLevel, player, opts) {
  opts = opts || {};
  const kinds = opts.kinds || ['normal', 'champion', 'unique'];
  const set = opts.monsters || HELL_SET, rows = [];
  const pdef = player ? playerDefense(player.S, !!player.missile) : 0;
  for (const id of set) {
    if (!DATA.monstats[id]) continue;
    for (const k of kinds) {
      const m = monsterAt(id, 2, areaLevel, k, opts);
      const row = { id, kind: k, lvl: m.lvl, ar: m.ar, def: m.def, dmgMin: m.dmgMin, dmgMax: m.dmgMax, life: m.life };
      if (player) {
        row.hit = hitChance(m.ar, m.lvl, pdef, player.clvl || 90);
        const o = Object.assign({ difficulty: 2 }, opts, { S: player.S });
        const avg8 = Math.round((m.dmgMin + m.dmgMax) / 2 * 256);
        row.physAfter = applyType8(0, avg8, o).dmg8 / 256;
        if (player.life) row.hitsToKill = row.physAfter > 0 ? Math.ceil((player.life - 255 / 256) / row.physAfter) : Infinity;
      }
      rows.push(row);
    }
  }
  const byKind = {};
  for (const k of kinds) {
    const r = rows.filter((x) => x.kind === k).sort((a, b) => (a.dmgMax - b.dmgMax));
    if (r.length) byKind[k] = { median: r[Math.floor(r.length / 2)], max: r[r.length - 1] };
  }
  return { areaLevel, playerDefense: pdef, rows, summary: byKind };
}

const API = { TYPES, TYPE, RESIST_PENALTY, muldiv, pdMul, effectiveResist, applyType8, applyHit8, killsFrom,
  rawToKill8, effectiveLife, playerDefense, hitChance, setData, monLvl, monsterLevels, monsterAt, playersAR, playersHP,
  typicalHellTable, HELL_SET, MAP_SET };
if (typeof module !== 'undefined' && module.exports) module.exports = API; else root.PD2Defense = API;
})(typeof self !== 'undefined' ? self : this);

/* ---- adv/re/skilldmg.js ---- */
/* Skill damage as the PD2 client shows it (character-screen damage box = SkillDesc.descdam, skill-tree tooltip lines =
   SkillDesc descline/dsc2line), plus what the server rolls where that differs. Game-code references and status in
   adv/re/skilldmg.md. Data: adv/re/skilldmg-data.json (adv/re/extract_skilldmg.py).

   skillDamage(skillId, ctx) -> { type, min, max, lenFrames?, edPct?, flat?, srcDam, source, descdam, display, parts, lines, server, notes }
   ctx = { D (engine data, prepared: statByName), SD (skilldmg-data, default require('./skilldmg-data.json')),
           level (skill level incl. +skills), blvl (hard points), levelsOf(id) -> {lvl, blvl}, T(statId) -> player total,
           charges (descdam 25: current charge count 0..3), concPct (descdam 12: Concentration's damage% if active),
           expansion (default true; descdam 12 uses Concentration only),
           weaponFn({edPct, flat, src, pre}) -> {min,max} (optional: the gear's weapon block, e.g. from charscreen.js; fills res.total) }
   All numbers are whole points (the game's 256ths are shifted the way each code path shifts them). */
(function (root) {
'use strict';
const tdiv = (a, b) => (b ? Math.trunc(a / b) : 0);
const i32 = x => x | 0;

// D2Common 0x6FD511E0: a*b/c with the game's overflow paths (a = percent/calc, b = value, c = 100 here)
function muldiv(a, b, c) {
  if (!c) return 0;
  if (b > 0x100000) return c <= (b >> 4) ? i32(tdiv(b, c) * a) : Math.trunc((a * b) / c);
  if (a > 0x10000) return c > (a >> 4) ? Math.trunc((a * b) / c) : i32(tdiv(a, c) * b);
  return tdiv(Math.imul(b, a), c);
}
function lvtier(l, t) {                                   // D2Common 0x6FD9DDB0 (level tiers 2-8, 9-16, 17-22, 23-28, 29+)
  if (l <= 1) return 0;
  if (l <= 8) return (l - 1) * t[0];
  if (l <= 16) return 7 * t[0] + (l - 8) * t[1];
  if (l <= 22) return 7 * t[0] + 8 * t[1] + (l - 16) * t[2];
  if (l <= 28) return 7 * t[0] + 8 * t[1] + 6 * t[2] + (l - 22) * t[3];
  return 7 * t[0] + 8 * t[1] + 6 * t[2] + 6 * t[3] + (l - 28) * t[4];
}
function lentier(l, t) {                                  // D2Common 0x6FD9E900 / 0x6FDB9DC0 (2-8, 9-16, 17+)
  if (l <= 8) return (l - 1) * t[0];
  if (l <= 16) return 7 * t[0] + (l - 8) * t[1];
  return 7 * t[0] + 8 * t[1] + (l - 16) * t[2];
}
function dm(l, a, b) {                                    // D2Common 0x6FD9DC30 (verified natively, FINDINGS.md)
  if (l <= 0) return 0;
  const t = tdiv(110 * l, l + 6); const v = tdiv(t * (b - a), 100) + a; return v > b ? b : v;
}

// ---------------------------------------------------------------- calc language (Fog #10253 bytecode, read as text)
function tokenize(s) {
  const out = []; let i = 0, q = 0;
  while (i < s.length) {
    const c = s[i];
    if (/\s/.test(c)) { i++; continue; }
    if (/[0-9]/.test(c)) { let j = i; while (j < s.length && /[0-9]/.test(s[j])) j++; out.push({ t: 'n', v: +s.slice(i, j) }); i = j; continue; }
    if (/[A-Za-z_]/.test(c)) { let j = i; while (j < s.length && /[A-Za-z_0-9]/.test(s[j])) j++; out.push({ t: 'id', v: s.slice(i, j) }); i = j; continue; }
    if (c === "'") { const j = s.indexOf("'", i + 1); out.push({ t: 's', v: s.slice(i + 1, j < 0 ? s.length : j) }); i = j < 0 ? s.length : j + 1; continue; }
    if (c === '"') { out.push({ t: 'o', v: (q++ & 1) ? ')' : '(' }); i++; continue; }   // leftover spreadsheet quotes group
    const two = s.slice(i, i + 2);
    if (['<=', '>=', '==', '!='].includes(two)) { out.push({ t: 'o', v: two }); i += 2; continue; }
    out.push({ t: 'o', v: c }); i++;
  }
  return out;
}
// Fog's compiler (Fog 0x6FF6A4A0) is a shunting-yard: an incoming operator with code c pops stacked operators whose
// precedence byte (Fog 0x6FF76E1C) is >= c. Codes: , 3 | < <= > >= == != 10-15 (stacked 15) | + 16 (17) | - 17 (17) |
// * 18 (19) | / 19 (19) | ^ 20 (20) | unary - 21 (21) | ? 22 (22); ':' is only a separator. So '?' binds tighter than
// everything on both sides: "a + b ? c : d" = a + (b ? c : d), "c ? x : y + z" = (c ? x : y) + z, "a < b ? c : d" =
// a < (b ? c : d); an operator inside an unparenthesised branch ("c ? x + 1 : y") underflows and the calc fails to
// compile (the loader then stores no calc).
const OPC = { ',': 3, '<': 10, '<=': 10, '>': 10, '>=': 10, '==': 10, '!=': 10, '+': 16, '-': 17, '*': 18, '/': 19, '^': 20, 'u-': 21, '?': 22 };
const OPP = { 3: 3, 10: 15, 16: 17, 17: 17, 18: 19, 19: 19, 20: 20, 21: 21, 22: 22 };
const ARITY = o => (o === 'u-' ? 1 : o === '?' ? 3 : 2);
function parse(src) {
  const T = tokenize(String(src)); const out = [], ops = [];     // ops: {o} or {mark:'(' | fn}
  let bad = false, prevOperand = false;
  const emit = o => {
    const n = ARITY(o.o); if (out.length < n) { bad = true; return; }
    const args = out.splice(out.length - n, n);
    if (o.o === 'u-') out.push({ k: 'neg', a: args[0] });
    else if (o.o === '?') out.push({ k: 't', c: args[0], a: args[1], b: args[2] });
    else out.push({ k: 'b', o: o.o, a: args[0], b: args[1] });
  };
  const pushOp = o => { const c = OPC[o]; while (ops.length && ops[ops.length - 1].o && OPP[OPC[ops[ops.length - 1].o]] >= c) emit(ops.pop()); if (o !== ',') ops.push({ o }); };
  for (let i = 0; i < T.length && !bad; i++) {
    const t = T[i];
    if (t.t === 'n') { out.push({ k: 'n', v: t.v }); prevOperand = true; continue; }
    if (t.t === 's') { const props = []; while (T[i + 1] && T[i + 1].t === 'o' && T[i + 1].v === '.') { i += 2; props.push(T[i] ? T[i].v : ''); } out.push({ k: 'q', name: t.v, props }); prevOperand = true; continue; }
    if (t.t === 'id') {
      if (T[i + 1] && T[i + 1].t === 'o' && T[i + 1].v === '(') { ops.push({ mark: 'fn', f: t.v.toLowerCase(), base: out.length }); i++; prevOperand = false; continue; }
      out.push({ k: 'id', v: t.v }); prevOperand = true; continue;
    }
    const v = t.v;
    if (v === '(') { ops.push({ mark: '(' }); prevOperand = false; continue; }
    if (v === ')') {
      while (ops.length && ops[ops.length - 1].o) emit(ops.pop());
      const m = ops.pop();
      if (m && m.mark === 'fn') { const args = out.splice(m.base); out.push({ k: 'fn', f: m.f, args }); }
      prevOperand = true; continue;
    }
    if (v === ':') { prevOperand = false; continue; }
    if (v === '-' && !prevOperand) { pushOp('u-'); continue; }
    if (v === '+' && !prevOperand) continue;
    if (OPC[v] !== undefined) { pushOp(v); prevOperand = false; continue; }
  }
  while (ops.length && !bad) { const o = ops.pop(); if (o.o) emit(o); }
  if (bad || out.length !== 1) return { k: 'bad' };
  return out[0];
}
const astCache = new Map();
function ast(src) { let a = astCache.get(src); if (!a) { a = parse(src); astCache.set(src, a); } return a; }

// an evaluation scope: {E (engine for this call), kind: 'skill'|'missile', sk|m, lvl}
function evalCalc(src, sc) {
  if (src === undefined || src === null || src === '' || sc.E.depth > 12) return 0;
  sc.E.depth++;
  try { return i32(ev(ast(src), sc)); } finally { sc.E.depth--; }
}
function ev(n, sc) {
  switch (n.k) {
    case 'n': return n.v;
    case 'neg': return -ev(n.a, sc);
    case 't': return ev(n.c, sc) ? ev(n.a, sc) : ev(n.b, sc);
    case 'b': {
      const a = ev(n.a, sc), b = ev(n.b, sc);
      switch (n.o) {
        case '+': return i32(a + b); case '-': return i32(a - b); case '*': return Math.imul(a, b); case '/': return tdiv(a, b);
        case '^': { if (b <= 0) return 1; let r = a; for (let k = 1; k < b; k++) r = Math.imul(r, a); return r; }
        case '<': return +(a < b); case '>': return +(a > b); case '<=': return +(a <= b); case '>=': return +(a >= b);
        case '==': return +(a === b); case '!=': return +(a !== b);
      }
      return 0;
    }
    case 'id': return sc.kind === 'missile' ? missKw(sc.E, sc.m, n.v, sc.lvl) : skillKw(sc.E, sc.sk, n.v, sc.lvl, sc);
    case 'q': return 0;
    case 'bad': return 0;
    case 'fn': return callFn(n, sc);
  }
  return 0;
}
function callFn(n, sc) {                                  // D2Common function table 0x6FDE9E24: min max rand skill miss stat sklvl
  const E = sc.E, a = n.args;
  switch (n.f) {
    case 'min': return Math.min(...a.map(x => ev(x, sc)));
    case 'max': return Math.max(...a.map(x => ev(x, sc)));
    case 'rand': return ev(a[0], sc);                      // 0x6FDA0CB0 rolls; a tooltip shows one roll, we show the low end
    case 'skill': {                                        // 0x6FDA1AF0: lvl = unit's total level of that skill, then keyword
      const q = a[0]; if (!q || q.k !== 'q') return 0;
      const sk = E.skillByName(q.name); if (!sk) return 0;
      const L = E.levelsOf(sk.id);
      return skillKw(E, sk, q.props[0] || 'lvl', L.lvl, { kind: 'skill', sk, lvl: L.lvl, E });
    }
    case 'sklvl': {                                        // 0x6FDA1AB0: level = keyword #2 in this context, keyword #3 of skill #1
      const q = a[0]; if (!q || q.k !== 'q') return 0;
      const sk = E.skillByName(q.name); if (!sk) return 0;
      const lv = sc.kind === 'skill' ? skillKw(E, sc.sk, q.props[0], sc.lvl, sc) : 0;
      return skillKw(E, sk, q.props[1] || 'lvl', lv, { kind: 'skill', sk, lvl: lv, E });
    }
    case 'miss': {                                         // 0x6FDA0C90 -> 0x6FDBA790 with this skill's level
      const q = a[0]; if (!q || q.k !== 'q') return 0;
      const m = E.missile(q.name); if (!m) return 0;
      return missKw(E, m, q.props[0] || 'lvl', sc.lvl);
    }
    case 'stat': {                                         // 0x6FDA0C30: .base = base list, .mod, otherwise (accr) full total
      const q = a[0]; if (!q || q.k !== 'q') return 0;
      const id = E.statId(q.name); if (id === undefined) return 0;
      if (id === 19) return E.baseAR ? E.baseAR() : E.T(19);
      return E.T(id);
    }
  }
  return 0;
}

// ---------------------------------------------------------------- D2Common skill damage functions
const MASTERY = { 1: 329, 2: 330, 3: 357, 4: 331, 5: 332, 12: 331 };     // stock 0x6FD9F870 (+ PD2 magic -> 357, PD 0x10268A50)
function masteryAdd(E, eti, v) { const st = MASTERY[eti]; if (!st) return 0; const m = E.T(st); return m ? muldiv(m, v, 100) : 0; }
function elemMin(E, sk, lvl, mastery) {                   // D2Common #10121 0x6FDA0460 (256ths)
  if (!sk || lvl <= 0) return 0;
  let v = (sk.emin + lvtier(lvl, sk.eminl)) << sk.hs;
  if (sk.esym && (v > 256 || sk.eminl[0] !== 0)) { const c = evalCalc(sk.esym, { E, kind: 'skill', sk, lvl }); if (c) v += muldiv(c, v, 100); }
  if (mastery) v += masteryAdd(E, sk.eti, v);
  return v;
}
function elemMax(E, sk, lvl, mastery) {                   // D2Common #11091 0x6FDA0360 (no low-value gate on the synergy)
  if (!sk || lvl <= 0) return 0;
  let v = (sk.emax + lvtier(lvl, sk.emaxl)) << sk.hs;
  if (sk.esym) { const c = evalCalc(sk.esym, { E, kind: 'skill', sk, lvl }); if (c) v += muldiv(c, v, 100); }
  if (mastery) v += masteryAdd(E, sk.eti, v);
  return v;
}
function elemLen(E, sk, lvl) {                            // D2Common #10510 0x6FD9E900 (frames; the mastery flag is ignored)
  if (!sk || lvl <= 0) return 0;
  let v = sk.elen + lentier(lvl, sk.elenl);
  if (sk.lsym) { const c = evalCalc(sk.lsym, { E, kind: 'skill', sk, lvl }); if (c) v += muldiv(c, v, 100); }
  return v;
}
function physMin(E, sk, lvl) {                            // D2Common #10567 0x6FDA2100 with weapon flag 0 (256ths)
  if (!sk) return 1;
  let v = sk.mind + lvtier(lvl, sk.minl);
  if (sk.dsym) { const c = evalCalc(sk.dsym, { E, kind: 'skill', sk, lvl }); if (c) v += muldiv(c, v, 100); }
  return v << sk.hs;
}
function physMax(E, sk, lvl) {                            // D2Common #10297 0x6FDA1FF0
  if (!sk) return 2;
  let v = sk.maxd + lvtier(lvl, sk.maxl);
  if (sk.dsym) { const c = evalCalc(sk.dsym, { E, kind: 'skill', sk, lvl }); if (c) v += muldiv(c, v, 100); }
  return v << sk.hs;
}
// missiles: synergy is applied before HitShift; no mastery here (the server adds it in #10413 when ApplyMastery is set)
function mSyn(E, m, v, calc, lvl) { if (!calc) return v; const c = evalCalc(calc, { E, kind: 'missile', m, lvl }); return c ? v + muldiv(c, v, 100) : v; }
const mElemMin = (E, m, lvl) => m ? mSyn(E, m, m.emin + lvtier(lvl, m.eminl), m.esym, lvl) << m.hs : 0;   // #10205 0x6FDBB360
const mElemMax = (E, m, lvl) => m ? mSyn(E, m, m.emax + lvtier(lvl, m.emaxl), m.esym, lvl) << m.hs : 0;   // #10532 0x6FDBA3E0
const mPhysMin = (E, m, lvl) => m ? mSyn(E, m, m.mind + lvtier(lvl, m.minl), m.dsym, lvl) << m.hs : 0;    // #10040 0x6FDBA580
const mPhysMax = (E, m, lvl) => m ? mSyn(E, m, m.maxd + lvtier(lvl, m.maxl), m.dsym, lvl) << m.hs : 0;    // #10256 0x6FDBA4B0
const mLen = (m, lvl) => !m ? 0 : lvl <= 0 ? m.elen : m.elen + lentier(lvl, m.elenl);                    // #10242 0x6FDB9DC0

// SkillCalc.txt keywords (D2Common 0x6FDA1070, table 0x6FDA174C)
function skillKw(E, sk, kw, lvl, sc) {
  if (!sk) return 0;
  const P = sk.p; let m;
  kw = String(kw || '');
  if ((m = /^par([1-8])$/.exec(kw))) return P[m[1] - 1];
  if ((m = /^ln([1-8])([1-8])$/.exec(kw))) return lvl > 0 ? P[m[1] - 1] + (lvl - 1) * P[m[2] - 1] : 0;
  if ((m = /^dm([1-8])([1-8])$/.exec(kw))) return dm(lvl, P[m[1] - 1], P[m[2] - 1]);
  if ((m = /^clc([1-4])$/.exec(kw))) return evalCalc(sk.calc[m[1] - 1], { E, kind: 'skill', sk, lvl });
  if ((m = /^(?:m([123])|me(3))(en|ex|el|rn|eo|ey|o|y)$/.exec(kw))) {                 // desc missile 1..3 (me3o/me3y spelling)
    const k = +(m[1] || m[2]); const suf = m[3]; if (lvl <= 0 && suf !== 'rn') return 0;
    const ms = E.descMissile(sk, k - 1); if (!ms) return 0;
    switch (suf) {
      case 'en': return mElemMin(E, ms, lvl) >> 8; case 'ex': return mElemMax(E, ms, lvl) >> 8;
      case 'eo': case 'o': return mElemMin(E, ms, lvl); case 'ey': case 'y': return mElemMax(E, ms, lvl);
      case 'el': return mLen(ms, lvl); case 'rn': return ms.range + lvl * ms.levRange;
    }
  }
  switch (kw) {
    case 'lvl': return lvl;
    case 'blvl': return E.levelsOf(sk.id).blvl;         // 0x6FDA14C6: the unit's skill +0x28 (hard points), clamped
    case 'ulvl': return E.T(12);
    case 'edmn': return elemMin(E, sk, lvl, 0) >> 8;   case 'edmx': return elemMax(E, sk, lvl, 0) >> 8;
    case 'edns': return elemMin(E, sk, lvl, 0);        case 'edxs': return elemMax(E, sk, lvl, 0);
    case 'enma': return elemMin(E, sk, lvl, 1) >> 8;   case 'exma': return elemMax(E, sk, lvl, 1) >> 8;
    case 'enms': return elemMin(E, sk, lvl, 1);        case 'exms': return elemMax(E, sk, lvl, 1);
    case 'edln': case 'edma': return elemLen(E, sk, lvl);
    case 'toht': return sk.thc ? evalCalc(sk.thc, { E, kind: 'skill', sk, lvl }) : (lvl > 0 ? sk.th + (lvl - 1) * sk.lth : 0);
  }
  return 0;                                              // mana/mps/usmc/math/madm/macr/len/rng/ast*/pst*/pets/skpt: not damage
}
// MissCalc.txt keywords (D2Common 0x6FDBA790, table 0x6FDBAA70)
function missKw(E, m, kw, lvl) {
  let k;
  if ((k = /^par([1-5])$/.exec(kw))) return m.p[k[1] - 1];
  switch (kw) {
    case 'lvl': return lvl;
    case 'edmn': return mElemMin(E, m, lvl) >> 8; case 'edmx': return mElemMax(E, m, lvl) >> 8;
    case 'edns': return mElemMin(E, m, lvl);      case 'edxs': return mElemMax(E, m, lvl);
    case 'edln': return mLen(m, lvl);
    case 'damn': return mPhysMin(E, m, lvl) >> 8; case 'damx': return mPhysMax(E, m, lvl) >> 8;
    case 'dmns': return mPhysMin(E, m, lvl);      case 'dmxs': return mPhysMax(E, m, lvl);
    case 'rang': return m.range + lvl * m.levRange;
    case 'sl12': return m.p[0] + (lvl - 1) * m.p[1];   case 'sl34': return m.p[2] + (lvl - 1) * m.p[3];
    case 'sd12': return dm(lvl, m.p[0], m.p[1]);       case 'sd34': return dm(lvl, m.p[2], m.p[3]);
  }
  return 0;
}

// ---------------------------------------------------------------- engine for one call
const ETN = { 0: 'phys', 1: 'fire', 2: 'ltng', 3: 'mag', 4: 'cold', 5: 'pois', 6: 'life', 7: 'mana', 8: 'stam', 9: 'stun', 10: 'rand', 11: 'burn', 12: 'cold' };
let _SD = null;
function loadSD(ctx) {
  if (ctx.SD) return ctx.SD;
  if (!_SD && typeof require === 'function') { try { _SD = require('./skilldmg-data.json'); } catch (e) { _SD = null; } }
  if (!_SD && root.PD2SkillDmgData) _SD = root.PD2SkillDmgData;
  if (!_SD) throw new Error('skilldmg: ctx.SD (skilldmg-data.json) is required');
  return _SD;
}
function makeEngine(ctx) {
  const SD = loadSD(ctx);
  const skill = id => { const s = SD.skills[id]; if (s && s.id === undefined) s.id = +id; return s || null; };
  const E = {
    SD, depth: 0,
    T: ctx.T || (() => 0),
    levelsOf: ctx.levelsOf || (() => ({ lvl: 0, blvl: 0 })),
    skill,
    skillByName: n => { const id = SD.skillByName[String(n).toLowerCase()]; return id === undefined ? null : (skill(id) || { id, stub: true, p: [0, 0, 0, 0, 0, 0, 0, 0], calc: [], emin: 0, eminl: [0, 0, 0, 0, 0], emax: 0, emaxl: [0, 0, 0, 0, 0], hs: 8, eti: 0 }); },
    missile: n => SD.missiles[String(n).toLowerCase()] || null,
    descMissile: (sk, k) => { const n = sk.desc && sk.desc.miss[k]; return n ? SD.missiles[n.toLowerCase()] || null : null; },
    statId: n => {
      const D = ctx.D; if (D && D.statByName && D.statByName[n] !== undefined) return D.statByName[n];
      if (D && D.isc) for (const [id, s] of Object.entries(D.isc)) if (s.n === n) return +id;
      return undefined;
    },
    baseAR: ctx.baseAR,
  };
  return E;
}

// item elemental damage of one element (D2Client 0x6FADD6E0, no mastery)
function itemElem(T, eti) {
  switch (eti) {
    case 1: return [T(48), T(49)]; case 2: return [T(50), T(51)]; case 3: return [T(52), T(53)];
    case 4: case 12: return [T(54), T(55)];
    case 5: { let len = T(101); if (len <= 0) len = tdiv(T(59), Math.max(T(326), 1)); return [(T(57) * len) >> 8, (T(58) * len) >> 8]; }
  }
  return [0, 0];
}
const r7 = (x, s) => { const v = x * s; return (v + (v < 0 ? 127 : 0)) >> 7; };           // (x*src)/128 toward zero (sar 7 after bias)

// ---------------------------------------------------------------- the character-screen damage box (descdam)
function skillDamage(skillId, ctx) {
  ctx = ctx || {};
  const E = makeEngine(ctx);
  const sk = E.skill(skillId);
  if (!sk) return null;
  const lvl = ctx.level !== undefined ? ctx.level : E.levelsOf(skillId).lvl;
  if (ctx.blvl !== undefined) { const lo = E.levelsOf; E.levelsOf = id => (+id === +skillId ? { lvl, blvl: ctx.blvl } : lo(id)); }
  const T = E.T, d = sk.desc || { descdam: 0, dd1: '', dd2: '', pdm: [], miss: [], lines: [] };
  const dc = src => (src ? evalCalc(src, { E, kind: 'skill', sk, lvl }) : 0);
  // building blocks (256ths -> points the way the handlers shift)
  const S = () => ({ min: physMin(E, sk, lvl) >> 8, max: physMax(E, sk, lvl) >> 8 });
  const Emast = () => ({ min: elemMin(E, sk, lvl, 1), max: elemMax(E, sk, lvl, 1) });
  const Eshown = () => {                                   // 0x6FADE190: E with mastery; poison x length
    const e = Emast();
    if (sk.eti === 5) { const len = elemLen(E, sk, lvl); return { min: (e.min * len) >> 8, max: (e.max * len) >> 8, len }; }
    return { min: e.min >> 8, max: e.max >> 8, len: sk.elen || sk.elenl.some(x => x) ? elemLen(E, sk, lvl) : undefined };
  };
  const et = ETN[sk.eti] || 'phys';
  const res = { skill: sk.n, id: +skillId, level: lvl, descdam: d.descdam, type: et, min: 0, max: 0, srcDam: sk.src,
                source: 'skill', display: 'range', parts: {}, notes: [], lines: [], server: null };
  const weapon = (edPct, flat, src, extra) => Object.assign({ edPct, flat, src }, extra || {});
  // ctx.weaponFn({edPct, flat, src, pre}) -> {min,max}: the weapon block D2Client 0x6FAE3240 (0x6FAE1220 physical + 0x6FAE0E30
  // item elemental) for the player's gear, e.g. built on charscreen.js. With it, res.total is the pair the box prints.
  const W = p => (ctx.weaponFn ? ctx.weaponFn(Object.assign({ edPct: 0, flat: 0, src: 128 }, p)) : null);
  const W128scaled = () => { const w = W({}); return w ? { min: r7(w.min, sk.src), max: r7(w.max, sk.src) } : null; };   // 0x6FAE4D70
  const setTotal = (mn, mx, w) => { if (w === null) return; res.total = { min: mn + (w ? w.min : 0), max: mx + (w ? w.max : 0) }; };
  const setE = (e) => { res.min += e.min; res.max += e.max; if (e.len !== undefined && e.len) res.lenFrames = e.len; };
  switch (d.descdam) {
    case 5: {                                             // 0x6FAE5270: W(SrcDam) + S + E (poison: E x len)
      const s = S(); res.parts.skillPhys = s; res.min += s.min; res.max += s.max;
      const e = Eshown(); res.parts.elem = Object.assign({ type: et }, e); setE(e);
      if (sk.src) { res.parts.weapon = weapon(0, 0, sk.src, { scaled: true }); res.notes.push('adds weapon damage x SrcDam/128 (' + sk.src + ')'); }
      if (!e.min && !e.max && (s.min || s.max)) res.type = 'phys';
      setTotal(res.min, res.max, sk.src ? W128scaled() : (ctx.weaponFn ? undefined : null));
      break;
    }
    case 6: {                                             // 0x6FAE5540: weapon part shown separately; skill part = S + E + same-element item damage
      const s = S(), e = Emast(); const ie = itemElem(T, sk.eti);
      res.min = s.min + (e.min >> 8) + ie[0]; res.max = s.max + (e.max >> 8) + ie[1];
      res.parts = { skillPhys: s, elem: { type: et, min: e.min >> 8, max: e.max >> 8 }, itemElem: ie, weapon: weapon(0, 0, sk.src, { separate: true, scaled: true }) };
      res.display = 'weapon + skill (two ranges)';
      if (ctx.weaponFn) { res.totalWeapon = sk.src ? W128scaled() : { min: 0, max: 0 }; res.total = { min: res.min, max: res.max }; }
      break;
    }
    case 1: case 7: case 19: case 13: {                   // 0x6FAE4C00 (1/19 per hand via 0x6FAE0B40; 13 = PD 0x102F8410 both weapons)
      const ed = dc(d.dd1), fl = dc(d.dd2);
      res.edPct = ed; res.flat = fl;
      res.parts.weapon = weapon(ed, fl, 128, { thenScale: sk.src !== 128 ? sk.src : undefined });
      const s = S(), e = Emast(); res.parts.skillPhys = s; res.parts.elem = { type: et, min: e.min >> 8, max: e.max >> 8 };
      res.min = s.min + (e.min >> 8); res.max = s.max + (e.max >> 8);          // no poison length on this path
      res.type = 'phys'; res.display = 'weapon damage with edPct/flat, plus the skill damage in min/max';
      { const w = W({ edPct: ed, flat: fl, src: 128 }); if (w) { if (sk.src !== 128) { w.min = muldiv(sk.src, w.min, 128); w.max = muldiv(sk.src, w.max, 128); } setTotal(res.min, res.max, w); } }
      if (d.descdam === 13) res.notes.push('PD2 descdam 13 (0x102F8410): both thrown weapons through the dual-weapon helper; READ');
      if (d.descdam === 1 || d.descdam === 19) res.notes.push('dual wield: each hand is computed with the other hand detached (0x6FAE0B40)');
      break;
    }
    case 8: {                                             // 0x6FAE07B0: per second = E*25*a/b (a = ddam calc1 or 1, b = calc2 or 1)
      const e = Emast(); const a = dc(d.dd1) || 1, b = dc(d.dd2) || 1;
      res.min = tdiv(a * e.min * 25, b) >> 8; res.max = tdiv(a * e.max * 25, b) >> 8;
      res.display = 'per second'; res.parts.elem = { type: et, min: e.min >> 8, max: e.max >> 8, perFrame: true, a, b };
      if (ctx.weaponFn) res.total = { min: res.min, max: res.max };
      break;
    }
    case 9: {                                             // 0x6FAE5070: ((MinDam<<HitShift) + E) * 75 / 256 = per 3 seconds; + W(SrcDam)
      const e = Emast();
      res.min = (((sk.mind << sk.hs) + e.min) * 75) >> 8; res.max = (((sk.maxd << sk.hs) + e.max) * 75) >> 8;
      res.display = 'per 3 seconds (75 frames)'; res.parts.elem = { type: et, min: e.min >> 8, max: e.max >> 8, perFrame: true };
      if (sk.src) res.parts.weapon = weapon(0, 0, sk.src, { scaled: true });
      setTotal(res.min, res.max, sk.src ? W128scaled() : (ctx.weaponFn ? undefined : null));
      break;
    }
    case 10: {                                            // 0x6FAE05D0 Smite: shield damage (+Holy Shield skill damage while state 101)
      const ed = lvl > 0 ? sk.p[2] + (lvl - 1) * sk.p[3] : 0;
      res.type = 'phys'; res.edPct = ed; res.display = 'shield damage';
      res.parts.shield = { edPct: ed, formula: 'min = sMin + trunc((pct*sMin + T18)/100), max = sMax + trunc((pct*sMax + T17)/100); pct = edPct + Str*StrBonus/100 + Dex*DexBonus/100 + T25 (>= -90); sMin/sMax = Armor.txt shield damage (+ Holy Shield #10567/#10297 when state 101)' };
      res.notes.push('T17/T18 are added to pct*dmg before /100, not multiplied (stock D2Client 0x6FAE0766)');
      break;
    }
    case 11: {                                            // PD 0x102F8040 Vengeance
      const conv = [dc(sk.calc[0]), dc(sk.calc[1]), dc(sk.calc[2])];
      res.type = 'phys'; res.display = 'weapon + converted elemental'; res.parts.weapon = weapon(0, 0, 128);
      res.parts.conversion = { fire: conv[0], cold: conv[1], ltng: conv[2], mastery: [T(329), T(331), T(330)] };
      res.notes.push('Vengeance (PD2 0x102F8040): weapon damage plus fire/cold/light = calc1/calc2/calc3 (+ that element\'s mastery) percent of it, float math; READ, not reproduced exactly');
      break;
    }
    case 12: {                                            // 0x6FAE04A0 Blessed Hammer: E (poison x len) x (100 + pct)/100
      const e = Eshown();
      const pct = ctx.expansion === false ? Math.max(T(25), -90) : (ctx.concPct || 0);
      res.min = e.min + tdiv(pct * e.min, 100); res.max = e.max + tdiv(pct * e.max, 100);
      res.parts.elem = Object.assign({ type: et }, e); res.parts.pct = pct;
      if (ctx.weaponFn) res.total = { min: res.min, max: res.max };
      res.notes.push('expansion: only the damage% of the Concentration aura state (D2Common #10037) applies; classic: T25');
      break;
    }
    case 15: case 16: {                                   // PD 0x102F8490 / 0x102F86B0 kicks (Dragon Talon/Flight, Dragon Tail)
      res.type = 'phys'; res.edPct = dc(d.dd1); res.display = 'kick damage';
      res.notes.push('PD2 kick handlers: boot kick damage with 100 + ddam calc1 + Str/Dex terms, float math; READ, only edPct returned');
      break;
    }
    case 17: case 23: {                                   // 0x6FAE40F0 / 0x6FAE4320: weapon (17: ddam calcs) and E shown as a second range
      const ed = d.descdam === 17 ? dc(d.dd1) : 0, fl = d.descdam === 17 ? dc(d.dd2) : 0;
      const e = Eshown(); res.min = e.min; res.max = e.max; if (e.len) res.lenFrames = e.len;
      res.edPct = ed; res.flat = fl; res.parts.weapon = weapon(ed, fl, 128, { separate: true });
      res.parts.elem = Object.assign({ type: et }, e); res.display = 'weapon + elemental (two ranges)';
      if (ctx.weaponFn) { res.totalWeapon = W({ edPct: ed, flat: fl, src: 128 }); res.total = { min: res.min, max: res.max }; }
      break;
    }
    case 21: case 22: {                                   // 0x6FAE08C0 / 0x6FAE4640: thrown weapon, then E as a second range
      const e = Eshown(); res.min = e.min; res.max = e.max; if (e.len) res.lenFrames = e.len;
      res.parts.elem = Object.assign({ type: et }, e);
      res.parts.weapon = weapon(0, 0, d.descdam === 22 ? sk.src : 128, { thrown: true, separate: true,
        formula: d.descdam === 21 ? 'T159/T160 x (100 + T18/T17 + Str/Dex bonus + T25)/100 + throw mastery (state 78) + same-element item damage, x SrcDam/128' : 'PD2 throw damage (0x102F91B0) x SrcDam/128' });
      res.display = 'thrown weapon + elemental (two ranges)';
      break;
    }
    case 25: {                                            // PD 0x102F8B60 Assassin charge-ups
      const ch = sk.aurastat1 ? Math.max(0, Math.min(ctx.charges || 0, 2)) : 0;     // charges = aurastat1 value in the aurastate's stat list
      const ed = dc(d.dd1) * (ch + 1);
      const p = d.pdm[ch] || { mn: '', mx: '', ei: 0 };
      res.min = dc(p.mn); res.max = dc(p.mx); res.type = ETN[p.ei] || 'phys'; res.edPct = ed; res.flat = 0;
      res.parts.weapon = weapon(ed, 0, 128); res.parts.charge = { charges: ch, column: 'p' + (ch + 1) + 'dm' };
      res.display = 'weapon damage with edPct + p{n}dmmin..p{n}dmmax (n = charges+1, max 3)';
      setTotal(res.min, res.max, W({ edPct: ed, src: 128 }));
      if (!(res.min && res.max)) res.notes.push('PD2 shows nothing unless both min and max are nonzero');
      break;
    }
    case 26: {                                            // PD 0x102F8CE0 Magic/Fire/Cold Arrow: weapon (src = SrcDam) + E x SrcDam/128
      const e = Emast(); res.parts.weapon = weapon(0, 0, sk.src);
      if (sk.src) { res.min = r7(e.min >> 8, sk.src); res.max = r7(e.max >> 8, sk.src); }
      res.parts.elem = { type: et, min: e.min >> 8, max: e.max >> 8 };
      if (!sk.src) res.notes.push('SrcDam 0: PD2 adds no elemental part at all');
      setTotal(res.min, res.max, W({ src: sk.src }));
      break;
    }
    case 27: {                                            // PD 0x102F8E20 Fire Claws: weapon range, plus E*75/256 (burning per 3 s)
      const e = Emast(); res.min = (e.min * 75) >> 8; res.max = (e.max * 75) >> 8;
      res.parts.weapon = weapon(0, 0, 128, { separate: true }); res.display = 'weapon + fire per 3 seconds'; res.parts.elem = { type: et, min: e.min >> 8, max: e.max >> 8, perFrame: true };
      break;
    }
    case 28: {                                            // PD 0x102F9100 Blade Sentinel/Fury: S is fed to the weapon block before ED
      const s = S(); res.min = s.min; res.max = s.max; res.type = 'phys';
      res.parts.weapon = weapon(0, 0, sk.src, { pre: s }); res.display = '(S + weapon*SrcDam/128) x (100 + ED)/100';
      { const w = W({ src: sk.src, pre: s }); if (w) res.total = { min: w.min, max: w.max }; }
      break;
    }
    case 2: {                                             // 0x6FAE0AE0 kick: (MinDam << (HitShift-8)) + T(137)
      res.type = 'phys'; res.min = res.max = (sk.mind << (sk.hs - 8)) + T(137); break;
    }
    case 3: case 4: {                                     // throw (PD 0x102F91B0)
      res.type = 'phys'; res.parts.weapon = weapon(0, 0, 128, { thrown: true }); break;
    }
    default: {                                            // no descdam: no damage box; fall back to the tooltip lines
      res.display = 'none'; res.notes.push('SkillDesc.descdam is empty: the character screen shows no damage for this skill');
    }
  }
  res.lines = tooltipLines(E, sk, lvl);
  // a skill whose box has no numbers of its own but whose tooltip carries missile damage: expose the missile as primary
  if (!res.min && !res.max && !(res.parts.weapon) && res.lines.length) {
    const L = res.lines.find(l => l.min || l.max);
    if (L) { res.min = L.min; res.max = L.max; res.type = L.type || res.type; res.source = L.source; if (L.lenFrames) res.lenFrames = L.lenFrames; res.notes.push('primary numbers taken from tooltip line type ' + L.t); }
  }
  res.server = serverDamage(E, sk, lvl);
  return res;
}

// ---------------------------------------------------------------- skill-tree tooltip damage lines (D2Client 0x6FAE16C0)
function tooltipLines(E, sk, lvl) {
  const d = sk.desc; if (!d) return [];
  const out = [];
  const dc = src => (src ? evalCalc(src, { E, kind: 'skill', sk, lvl }) : 0);
  const et = ETN[sk.eti] || 'phys';
  for (const L of d.lines) {
    if (L.g === 'dsc3') continue;                         // synergy text block
    const base = { g: L.g, i: L.i, t: L.t };
    switch (L.t) {
      case 9: {                                           // 0x6FADD000: S + S*a/100 + b
        const a = dc(L.ca), b = dc(L.cb); const s0 = physMin(E, sk, lvl) >> 8, s1 = physMax(E, sk, lvl) >> 8;
        const mn = s0 + muldiv(s0, a, 100) + b, mx = s1 + muldiv(s1, a, 100) + b;
        if (mn || mx) out.push(Object.assign(base, { type: 'phys', min: mn, max: mx, source: 'skill' }));
        break;
      }
      case 10: case 24: {                                 // 0x6FADEF80: E with mastery
        const mn = elemMin(E, sk, lvl, 1) >> 8, mx = elemMax(E, sk, lvl, 1) >> 8;
        if (mn || mx) out.push(Object.assign(base, { type: et, min: mn, max: mx, source: 'skill' }));
        break;
      }
      case 11: { const len = elemLen(E, sk, lvl); if (len > 0) out.push(Object.assign(base, { type: et, lenFrames: len, source: 'skill' })); break; }   // 0x6FADF2E0 duration
      case 14: {                                          // 0x6FADEC60: (E x len) over len frames
        const len = elemLen(E, sk, lvl);
        out.push(Object.assign(base, { type: et, min: (elemMin(E, sk, lvl, 1) * len) >> 8, max: (elemMax(E, sk, lvl, 1) * len) >> 8, lenFrames: len, source: 'skill' }));
        break;
      }
      case 26: case 27: {                                 // 0x6FADEB80 per second (x25), 0x6FADED80 per 3 s (x75)
        const k = L.t === 26 ? 25 : 75;
        out.push(Object.assign(base, { type: et, min: (elemMin(E, sk, lvl, 1) * k) >> 8, max: (elemMax(E, sk, lvl, 1) * k) >> 8, per: k, source: 'skill' }));
        break;
      }
      case 22: {                                          // 0x6FADEDD0: descmissile1 E x75, + fire/light mastery if the SKILL is fire/ltng
        const m = E.descMissile(sk, 0); if (!m) break;
        let a = mElemMin(E, m, lvl) * 75, b = mElemMax(E, m, lvl) * 75;
        if (sk.eti === 1 || sk.eti === 2) { const ms = E.T(sk.eti === 1 ? 329 : 330); if (ms) { a += muldiv(ms, a, 100); b += muldiv(ms, b, 100); } }
        out.push(Object.assign(base, { type: ETN[m.eti] || 'phys', min: a >> 8, max: b >> 8, per: 75, source: 'missile', missile: m.n }));
        break;
      }
      case 50: {                                          // 0x6FADEF20: descmissile1 E, no mastery
        const m = E.descMissile(sk, 0); if (!m) break;
        const mn = mElemMin(E, m, lvl) >> 8, mx = mElemMax(E, m, lvl) >> 8;
        if (mn || mx) out.push(Object.assign(base, { type: ETN[m.eti] || 'phys', min: mn, max: mx, source: 'missile', missile: m.n }));
        break;
      }
      default: {                                          // calc-driven lines that print a damage keyword
        const dmgKw = /\b(edmn|edmx|edns|edxs|enma|exma|enms|exms|m[123]e[nxoy]|me3[oy])\b|miss\(/;
        // range-printing line types whose calcs read damage keywords (38/47/59-61 print a-b; 43/44 print 256ths as decimals)
        if ([38, 43, 44, 47, 59, 60, 61].includes(L.t) && (dmgKw.test(L.ca) || dmgKw.test(L.cb))) {
          const src = /m[123]e|me3|miss\(/.test(L.ca + L.cb) ? 'missile' : 'skill';
          const a = dc(L.ca), b = L.cb ? dc(L.cb) : a, fx = L.t === 43 || L.t === 44;
          out.push(Object.assign(base, { calcA: L.ca, calcB: L.cb, a, b, texta: L.ta, textb: L.tb, source: src,
                                          min: fx ? a / 256 : a, max: fx ? b / 256 : b, fixed256: fx || undefined }));
        }
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------- server (D2Common #10413 0x6FDBBAA0: missile damage setup)
// A missile whose Missiles.Skill names a skill, or with the MissileSkill flag (the creating skill), rolls that skill's
// #10567/#10297 physical and #10121/#11091 elemental WITH mastery (flag 1) and #10510 length; SrcDam = Skills.SrcDam
// (0 if the missile's SrcDamage is 255). Otherwise the missile's own Min/MaxDamage, EMin/EMax and ELen at the skill level,
// plus mastery only when ApplyMastery is set (0x6FDBAB20 -> PD 0x10268A10). When SrcDam != 0 the weapon damage is added
// and then every damage slot, skill elemental included, is scaled by SrcDam/128 (0x6FDB9C60).
function serverDamage(E, sk, lvl) {
  const sh = v => v >> 8;
  const out = { skill: { type: ETN[sk.eti] || 'phys', physMin: sh(physMin(E, sk, lvl)), physMax: sh(physMax(E, sk, lvl)),
                         elemMin: sh(elemMin(E, sk, lvl, 1)), elemMax: sh(elemMax(E, sk, lvl, 1)), lenFrames: elemLen(E, sk, lvl), srcDam: sk.src }, missiles: [] };
  const seen = new Set(); const names = [];
  for (const n of sk.srvmissile || []) { const m = E.missile(n); if (!m || seen.has(m.n)) continue; seen.add(m.n); names.push([m, 0]);
    for (const c of m.sub || []) { const m2 = E.missile(c); if (m2 && !seen.has(m2.n)) { seen.add(m2.n); names.push([m2, 1]); } } }
  const sc = (v, src) => (src && src !== 128 ? r7(v, src) : v);
  for (const [m, depth] of names) {
    const linked = m.missileSkill ? sk : (m.skill ? E.skillByName(m.skill) : null);
    if (linked && !linked.stub) {
      const src = m.src === 255 ? 0 : linked.src;
      out.missiles.push({ missile: m.n, sub: !!depth, uses: 'skill ' + linked.n, type: ETN[linked.eti] || 'phys', srcDam: src,
        elemMin: sh(sc(elemMin(E, linked, lvl, 1), src)), elemMax: sh(sc(elemMax(E, linked, lvl, 1), src)), lenFrames: elemLen(E, linked, lvl),
        physMin: sh(physMin(E, linked, lvl)), physMax: sh(physMax(E, linked, lvl)), mastery: true });
    } else {
      let a = mElemMin(E, m, lvl), b = mElemMax(E, m, lvl);
      if (m.applyMastery) { a += masteryAdd(E, m.eti, a); b += masteryAdd(E, m.eti, b); }
      if (!(a || b || m.mind || m.maxd)) continue;
      out.missiles.push({ missile: m.n, sub: !!depth, uses: 'missile', type: ETN[m.eti] || 'phys', srcDam: m.src,
        elemMin: sh(sc(a, m.src)), elemMax: sh(sc(b, m.src)), lenFrames: mLen(m, lvl), physMin: sh(mPhysMin(E, m, lvl)), physMax: sh(mPhysMax(E, m, lvl)), mastery: !!m.applyMastery });
    }
  }
  return out;
}

const API = { skillDamage, tooltipLines, serverDamage, evalCalc: (src, ctx, skillId, lvl) => { const E = makeEngine(ctx); return evalCalc(src, { E, kind: 'skill', sk: E.skill(skillId), lvl }); },
  elemMin: (ctx, id, lvl, m) => { const E = makeEngine(ctx); return elemMin(E, E.skill(id), lvl, m); },
  elemMax: (ctx, id, lvl, m) => { const E = makeEngine(ctx); return elemMax(E, E.skill(id), lvl, m); },
  elemLen: (ctx, id, lvl) => { const E = makeEngine(ctx); return elemLen(E, E.skill(id), lvl); },
  physMin: (ctx, id, lvl) => { const E = makeEngine(ctx); return physMin(E, E.skill(id), lvl); },
  physMax: (ctx, id, lvl) => { const E = makeEngine(ctx); return physMax(E, E.skill(id), lvl); },
  evalMissCalc: (src, ctx, name, lvl) => { const E = makeEngine(ctx); return evalCalc(src, { E, kind: 'missile', m: E.missile(name), lvl }); },
  missile: (ctx, name, lvl) => { const E = makeEngine(ctx); const m = E.missile(name); return m && { emin: mElemMin(E, m, lvl), emax: mElemMax(E, m, lvl), len: mLen(m, lvl), pmin: mPhysMin(E, m, lvl), pmax: mPhysMax(E, m, lvl) }; },
  muldiv, lvtier, lentier, dm, itemElem };
if (typeof module !== 'undefined' && module.exports) module.exports = API; else root.PD2SkillDmg = API;
})(typeof window !== 'undefined' ? window : globalThis);

/* ---- adv/re/minions.js ---- */
/* PD2 minions: summoned monsters and mercenaries (Diablo II 1.13c + ProjectDiablo.dll).
   Every rule below is read from the game's code; addresses and VERIFIED/READ status are in adv/re/minions.md.
   Data: adv/re/minions.json (built by adv/re/extract_minions.py from the .bin tables inside PD2's data.zip).

   API (Node: require('./minions.js'); browser: window.PD2Minions, call setData(json) first)
     evalCalc(expr, ctx)                     one decompiled Skills.txt calc (see ctx below)
     summonStats(skill, o)  -> {name, monster, count, level, life, lifeMin, lifeMax, dmgMin, dmgMax, ar, def,
                                res:{fire,cold,light,poison,magic,phys}, elem, skills, stats, notes}
       skill: Skills.txt name or id.  o = {
         lvl      effective level of the summoning skill (hard + all bonuses)          [required]
         blvl     hard points in it                                                    [default lvl]
         levelsOf name -> {lvl, blvl} for the owner's OTHER skills (masteries, synergies) [default none]
         clvl     owner character level                                                [required]
         T        owner stat totals: {statName|statId: value} (extra_golem, passive_summon_resist, ...)
         difficulty 0/1/2 (default 2), ladder (MonLvl L- columns, default false), mode 'A1'|'A2'|'S1'
         revive   {monster: MonStats Id, level: its level when it died}   (Revive only)
         ownerWeapon {min, max}   owner's weapon/unit damage for SrcDam (Decoy/Dopplezon only) }
     mercStats(m, T, o)     -> {row, name, subtype, level, str, dex, life, def, ar, arPct, dmgMin, dmgMax,
                                res, resDisplay, skills, base, notes}
       m = {type (Hireling Id; = the save's / Armory's mercenary type) | class+act+difficulty+subtype,
            level | experience, expansion (default true)}
       T = merc item stat totals as the unit sees them (item-level ops such as an item's own ED% already
           applied inside each item), plus any party auras (aurastats) -> {statName|statId: value}
       o = {difficulty (current game, for the displayed resist), weapon: {twoHanded, min1, max1, min2, max2,
            StrBonus, DexBonus, normalDamage}, ownAuras (default true)} */
(function (root) {
'use strict';
let D = null;
function setData(d) { D = d; D._sid = {}; D.stats.forEach((n, i) => { D._sid[n] = i; }); return API; }

// ------------------------------------------------------------------ 32-bit helpers
const i32 = v => v | 0;
const tdiv = (a, b) => (b ? i32(a / b) : 0);
const imul = Math.imul;
function muldiv(a, b, c) { return c ? Math.trunc((a * b) / c) : 0; }   // 0x6FD511E0 / 0x6FC214D0 (64-bit safe paths)
// v * p / 100 the way the stat setters do it (0x6FC6FCFD, 0x6FCB16B5, 0x6FCFBEE8): big values divide first
function pctOf(v, p) {
  if (v > 0x100000) return imul(tdiv(v, 100), p);
  if (p > 0x10000) return imul(tdiv(p, 100), v);
  return tdiv(imul(v, p), 100);
}

// ------------------------------------------------------------------ calc language (decompiled byte code)
// The strings in minions.json are fully parenthesised decompilations of skillscode.bin, so precedence
// is already fixed by the game's own compiler; this parser only has to read them back.
function tokenize(s) {
  const out = []; let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === ' ') { i++; continue; }
    if (/[0-9]/.test(c)) { let j = i; while (j < s.length && /[0-9]/.test(s[j])) j++; out.push({ t: 'n', v: +s.slice(i, j) }); i = j; continue; }
    if (/[A-Za-z_]/.test(c)) { let j = i; while (j < s.length && /[A-Za-z_0-9]/.test(s[j])) j++; out.push({ t: 'id', v: s.slice(i, j) }); i = j; continue; }
    if (c === "'") { const j = s.indexOf("'", i + 1); out.push({ t: 's', v: s.slice(i + 1, j) }); i = j + 1; continue; }
    const two = s.slice(i, i + 2);
    if (['<=', '>=', '==', '!='].includes(two)) { out.push({ t: 'o', v: two }); i += 2; continue; }
    out.push({ t: 'o', v: c }); i++;
  }
  return out;
}
function parse(src) {
  const T = tokenize(src); let p = 0;
  const peek = () => T[p], take = () => T[p++];
  function expr() {                       // a (b) | (a op b) | (c?a:b) | (-a) | fn(...) | skill('X'.kw) | stat('s'.m) | kw | n
    const t = take();
    if (t.t === 'n') return { k: 'n', v: t.v };
    if (t.v === '-') { const a = expr(); return a.k === 'n' ? { k: 'n', v: -a.v } : { k: 'neg', a }; }
    if (t.v === '(') return rest(expr());
    if (t.t === 'id') {
      if (peek() && peek().v === '(') {
        take();
        if (t.v === 'skill' || t.v === 'stat') { const name = take().v; take(); const kw = take().v; take(); return { k: t.v, name, kw }; }
        const args = [expr()]; while (peek().v === ',') { take(); args.push(expr()); } take();
        return { k: 'fn', f: t.v, args };
      }
      return { k: 'kw', v: t.v };
    }
    throw new Error('calc parse: ' + src);
  }
  function rest(a) {                      // after '(' a : ')' | op b ')' | '?' x ':' y ')'
    const o = take().v;
    if (o === ')') return a;
    if (o === '?') { const x = expr(); take(); const y = expr(); take(); return { k: 't', c: a, a: x, b: y }; }
    const b = expr(); take(); return { k: 'b', o, a, b };
  }
  return expr();
}
const cache = new Map();
function evalCalc(src, ctx) {
  if (src === null || src === undefined || src === '') return 0;
  let ast = cache.get(src); if (!ast) { ast = parse(String(src)); cache.set(src, ast); }
  return ev(ast, ctx);
}
function ev(n, c) {
  switch (n.k) {
    case 'n': return n.v;
    case 'neg': return i32(-ev(n.a, c));
    case 't': return ev(n.c, c) ? ev(n.a, c) : ev(n.b, c);        // op 22
    case 'b': {
      const a = ev(n.a, c), b = ev(n.b, c);
      switch (n.o) {
        case '+': return i32(a + b); case '-': return i32(a - b); case '*': return imul(a, b);
        case '/': return b ? i32(a / b) : 0;                          // op 19: x/0 pushes 0
        case '^': { if (b <= 0) return 1; let r = a; for (let k = 1; k < b; k++) r = imul(r, a); return r; }
        case '<': return +(a < b); case '>': return +(a > b); case '<=': return +(a <= b); case '>=': return +(a >= b);
        case '==': return +(a === b); case '!=': return +(a !== b);
      }
      return 0;
    }
    case 'fn': {
      const v = n.args.map(x => ev(x, c));
      if (n.f === 'min') return v[0] < v[1] ? v[0] : v[1];         // D2Common 0x6FD9F0D0
      if (n.f === 'max') return v[0] > v[1] ? v[0] : v[1];         // D2Common 0x6FD9F0C0
      return 0;                                                      // rand/fn4/fn6: not used by minion calcs
    }
    case 'skill': {                                                  // fn 3 = D2Common 0x6FDA1AF0
      if (c.skillRef) return c.skillRef(n.name, n.kw);
      const sk = D.skills[n.name]; if (!sk) return 0;
      const L = (c.levelsOf && c.levelsOf(n.name)) || { lvl: 0, blvl: 0 };
      return kw(sk, n.kw, Object.assign({}, c, { sk, lvl: L.lvl | 0, blvl: L.blvl | 0 }));
    }
    case 'stat': return c.statRef ? c.statRef(n.name, n.kw) : statOf(c.T, n.name);   // fn 5 (mode 0 = total)
    case 'kw': return c.kwRef ? c.kwRef(n.v) : kw(c.sk, n.v, c);
  }
  return 0;
}
function statOf(T, name) {
  if (!T) return 0;
  if (T[name] !== undefined) return T[name] | 0;
  const id = D && D._sid[name]; if (id !== undefined && T[id] !== undefined) return T[id] | 0;
  return 0;
}
// ---- keywords of skill `sk` at level ctx.lvl (D2Common 0x6FDA1070, table 0x6FDA174C)
function lvtier(l, t) {                                             // D2Common 0x6FD9DDB0
  if (l <= 1) return 0;
  if (l <= 8) return (l - 1) * t[0];
  if (l <= 16) return 7 * t[0] + (l - 8) * t[1];
  if (l <= 22) return 7 * t[0] + 8 * t[1] + (l - 16) * t[2];
  if (l <= 28) return 7 * t[0] + 8 * t[1] + 6 * t[2] + (l - 22) * t[3];
  return 7 * t[0] + 8 * t[1] + 6 * t[2] + 6 * t[3] + (l - 28) * t[4];
}
function lentier(l, t) { if (l <= 1) return 0; if (l <= 8) return (l - 1) * t[0]; if (l <= 16) return 7 * t[0] + (l - 8) * t[1]; return 7 * t[0] + 8 * t[1] + (l - 16) * t[2]; }
function dm(l, a, b) { if (l <= 0) return 0; const t = tdiv(110 * l, l + 6); const v = tdiv(t * (b - a), 100) + a; return v > b ? b : v; }   // 0x6FD9DC30 (verified natively)
function elemDmg(sk, which, c) {                                    // 0x6FDA0460 (min) / 0x6FDA0360 (max), no mastery
  const L = c.lvl; if (L <= 0) return 0;
  const lev = which === 'min' ? sk.EMinLev : sk.EMaxLev;
  let v = ((which === 'min' ? sk.EMin : sk.EMax) + lvtier(L, lev)) << sk.HitShift;
  if (sk.EDmgSymPerCalc && (v > 256 || lev[0] !== 0)) { const p = evalCalc(sk.EDmgSymPerCalc, c); if (p) v += muldiv(v, p, 100); }
  return v;
}
function physDmg(sk, which, c, srcWeapon) {                         // #10567 (min, 0x6FDA2100) / #10297 (max)
  const L = c.lvl;
  let v = srcWeapon && sk.SrcDam ? (srcWeapon * sk.SrcDam) >> 7 : 0;
  v += (which === 'min' ? sk.MinDam : sk.MaxDam) + lvtier(L, which === 'min' ? sk.MinLevDam : sk.MaxLevDam);
  if (sk.DmgSymPerCalc) { const p = evalCalc(sk.DmgSymPerCalc, c); if (p) v += muldiv(v, p, 100); }
  return v << sk.HitShift;
}
function kw(sk, k, c) {
  if (!sk) return 0;
  const L = c.lvl | 0; let m;
  if ((m = /^par([1-8])$/.exec(k))) return sk.par[m[1] - 1];
  if ((m = /^ln([1-8])([1-8])$/.exec(k))) return L > 0 ? i32(sk.par[m[1] - 1] + imul(L - 1, sk.par[m[2] - 1])) : 0;   // 0x6FD51670
  if ((m = /^dm([1-8])([1-8])$/.exec(k))) return dm(L, sk.par[m[1] - 1], sk.par[m[2] - 1]);
  switch (k) {
    case 'lvl': return L;
    case 'blvl': return c.blvl | 0;
    case 'ulvl': return c.ulvl | 0;
    case 'edmn': return elemDmg(sk, 'min', c) >> 8;
    case 'edmx': return elemDmg(sk, 'max', c) >> 8;
    case 'edns': return elemDmg(sk, 'min', c);
    case 'edxs': return elemDmg(sk, 'max', c);
    case 'edln': return sk.ELen + lentier(L, sk.ELevLen);
    case 'toht': return toHit(sk, c);
  }
  return 0;
}
function toHit(sk, c) { if ((c.lvl | 0) <= 0) return 0; return sk.ToHitCalc ? evalCalc(sk.ToHitCalc, c) : sk.ToHit + (c.lvl - 1) * sk.LevToHit; }   // #10653

// ------------------------------------------------------------------ helpers over the tables
function skillRec(s) { if (typeof s === 'number') { for (const k in D.skills) if (D.skills[k].id === s) return D.skills[k]; return null; } return D.skills[s] || null; }
function monlvl(L) { return D.monlvl[Math.max(0, Math.min(L, D.monlvl.length - 1))]; }
const RES = { fire: 'fireresist', cold: 'coldresist', light: 'lightresist', poison: 'poisonresist', magic: 'magicresist', phys: 'damageresist' };

// ------------------------------------------------------------------ summons
const MONCOLS = ['Level', 'minHP', 'maxHP', 'AC', 'A1TH', 'A2TH', 'S1TH', 'A1MinD', 'A1MaxD', 'A2MinD', 'A2MaxD', 'S1MinD', 'S1MaxD',
  'ResDm', 'ResMa', 'ResFi', 'ResLi', 'ResCo', 'ResPo'];
function normMon(m) {                     // rows outside the summon set are stored without empty columns
  if (!m) return m; const r = Object.assign({ noRatio: false, boss: false, SkillDamage: null, skills: [] }, m);
  for (const c of MONCOLS) if (!r[c]) r[c] = [0, 0, 0];
  return r;
}
function summonStats(skill, o) {
  o = o || {};
  const sk = skillRec(skill); if (!sk) throw new Error('unknown skill ' + skill);
  const d = o.difficulty === undefined ? 2 : o.difficulty, lad = !!o.ladder, clvl = o.clvl | 0;
  const lvl = o.lvl | 0, blvl = o.blvl === undefined ? lvl : o.blvl | 0;
  const notes = [];
  const owner = { sk, lvl, blvl, ulvl: clvl, levelsOf: o.levelsOf, T: o.T || {} };   // calc unit = owner
  const count = evalCalc(sk.petmax, owner);
  const fn = sk.srvdofunc;
  let monName = sk.summon;
  if (fn === 58) { if (!o.revive) throw new Error('Revive needs o.revive = {monster, level}'); monName = o.revive.monster; }
  const mon = normMon(D.monstats[monName]);
  const out = { name: sk.name, monster: monName, count, notes };
  if (!mon) { out.notes.push('no MonStats row in minions.json for ' + monName); return out; }
  const S = {};                                         // pet stats by name (base list + attached lists)
  const add = (s, v) => { S[s] = (S[s] || 0) + v; };
  // --- monster init (D2Game 0x6FCCFDB0): resists from MonStats[d]; noRatio -> raw HP/AC
  for (const [col, st] of [['ResDm', 'damageresist'], ['ResMa', 'magicresist'], ['ResFi', 'fireresist'], ['ResLi', 'lightresist'], ['ResCo', 'coldresist'], ['ResPo', 'poisonresist']]) add(st, mon[col][d]);
  const spawnL = fn === 58 ? (o.revive.level | 0) : mon.Level[d];
  const ML0 = monlvl(spawnL);
  const sc = (v, col) => (mon.noRatio ? v : muldiv(v, (lad ? ML0['L' + col] : ML0[col])[d], 100));   // #11089
  let hpMin = sc(mon.minHP[d], 'HP') << 8, hpMax = sc(mon.maxHP[d], 'HP') << 8;
  S.armorclass = sc(mon.AC[d], 'AC');
  let level = spawnL;
  // --- per do-func level / MonLvl defense+AR (0x6FC6E2A0: level<=0 -> min(clvl, max(1, 3*clvl/4 + lvl)))
  // #10551 AddUnitStat: MonLvl AC/TH are ADDED to the spawn values (VERIFIED natively)
  const std = L => { const r = monlvl(L); add('armorclass', (lad ? r.LAC : r.AC)[d]); add('tohit', (lad ? r.LTH : r.TH)[d]); };
  if ([16, 31, 56, 57, 44, 45].includes(fn)) { level = Math.min(clvl, Math.max(1, tdiv(3 * clvl, 4) + lvl)); std(level); }
  else if (fn === 114 || fn === 119) { level = Math.max(1, evalCalc(sk.calc[1], owner)); std(level); }   // calc2
  else if (fn === 115) { level = Math.max(1, evalCalc(sk.calc[1], owner)); notes.push('vines: only the level is set; defense/AR stay MonStats raw'); }
  else if (fn === 49) { level = clvl; }
  else if (fn === 58) {
    const mlvl = spawnL;
    if (clvl < mlvl && mlvl) { hpMin = Math.max(1, muldiv(clvl, hpMin, mlvl)); hpMax = Math.max(1, muldiv(clvl, hpMax, mlvl)); level = clvl; }
    notes.push('revive: HP rolled from MonStats x MonLvl HP at the corpse level, scaled by clvl/mlvl; defense kept from its spawn');
  } else notes.push('srvdofunc ' + fn + ': level/defense not modelled');
  const pet = { lvl, blvl: 0, ulvl: level, T: S };                  // calc unit = the pet (do-func 49 only)
  // --- stat setter
  const skills = [];
  if (fn === 49) {                                                   // D2Game 0x6FCB1660
    if (lvl > 1) {                                                   // lvl <= 1 returns before touching anything
      const pct = (lvl - 1) * sk.par[0]; hpMin += pctOf(hpMin, pct); hpMax += pctOf(hpMax, pct);
      const slot = (a, k) => { const x = a.find(e => e[2] === k); return x ? x[1] : null; };
      const ac2 = slot(sk.aurastat, 1), pc2 = slot(sk.passivestat, 1);
      for (const [st] of sk.aurastat) add(st, evalCalc(ac2, Object.assign({}, pet, { sk })));      // stock: always aurastatcalc2
      for (const [st] of sk.passivestat) add(st, evalCalc(pc2, Object.assign({}, pet, { sk })));   // stock: always passivecalc2
      notes.push('do-func 49 evaluates aurastatcalc2 / passivecalc2 for every aurastat / passivestat (stock 1.13c, VERIFIED)');
    } else notes.push('skill level 1: do-func 49 adds no life bonus and no stats');
    notes.push('shadows/decoy also get MonEquip items (0x6FCB2ED0) that are not modelled');
  } else if (fn !== 144) {                                          // D2Game 0x6FC6F970 (PD wrapper 0x102CA430)
    for (const [st, c] of sk.passivestat) add(st, evalCalc(c, owner));          // AddUnitStat, owner calc
    for (const [st, c] of sk.aurastat) { const v = evalCalc(c, owner); if (v) add(st, v); }   // one list, value != 0
    const lifePct = evalCalc(sk.calc[0], owner);                     // calc1 = % maxhp
    const pm = S.maxhp || 0;
    hpMin += pm; hpMax += pm; delete S.maxhp;
    if (lifePct) { hpMin += pctOf(hpMin, lifePct); hpMax += pctOf(hpMax, lifePct); }
    for (const [name, c] of sk.sumskill) { const v = evalCalc(c, owner); if (v > 0) skills.push({ skill: name, lvl: v }); }
    if ([31, 56, 57].includes(fn)) {                                 // 0x6FC6E180: passive_summon_resist (stat 349)
      const r = statOf(o.T, 'passive_summon_resist');
      if (r > 0) {
        if (!(S.item_absorbfire_percent > 0)) add('fireresist', r);
        if (!(S.item_absorblight_percent > 0)) add('lightresist', r);
        if (!(S.item_absorbcold_percent > 0)) add('coldresist', r);
        add('poisonresist', r);
      }
    }
  }
  if (fn === 57) notes.push('Iron Golem also takes the stats of the item it was made from (0x6FCF60D0), not modelled');
  if (fn === 144 || fn === 45 || fn === 44) notes.push('damage comes from the pet skills (sumskill levels), not from its own stats');
  // --- attack-time damage/AR (D2Game 0x6FC97240): scaler at the CURRENT level, + owner skill for SkillDamage pets
  const mode = o.mode || 'A1';
  const MLc = monlvl(level);
  const scd = (v, col) => (mon.noRatio ? v : muldiv(v, (lad ? MLc['L' + col] : MLc[col])[d], 100));
  let dmin = scd(mon[mode + 'MinD'][d], 'DM'), dmax = scd(mon[mode + 'MaxD'][d], 'DM');
  let ar = scd(mon[mode + 'TH'][d], 'TH') + (S.tohit || 0);
  if (mon.SkillDamage) {                                             // 0x6FCBF2B0 -> 0x6FCBE330
    const ssk = D.skills[mon.SkillDamage];
    const L = (mon.SkillDamage === sk.name) ? { lvl, blvl } : ((o.levelsOf && o.levelsOf(mon.SkillDamage)) || { lvl: 0, blvl: 0 });
    const c2 = Object.assign({}, owner, { sk: ssk, lvl: L.lvl, blvl: L.blvl });
    const w = o.ownerWeapon || { min: 0, max: 0 };
    dmin += physDmg(ssk, 'min', c2, w.min << 8) >> 8; dmax += physDmg(ssk, 'max', c2, w.max << 8) >> 8;
    ar += toHit(ssk, c2);
    if (ssk.SrcDam && !o.ownerWeapon) notes.push(ssk.name + ' has SrcDam ' + ssk.SrcDam + '/128: pass o.ownerWeapon');
  }
  // physical damage (D2Game 0x6FCFC530, no weapon): min>=1, max>=2, + item_normaldamage, x (100+damagepercent)
  let mn = Math.max(dmin, 1) << 8, mx = Math.max(dmax, 2) << 8;
  const nd = (S.item_normaldamage || 0) << 8; mn += nd; mx += nd;
  if (mn < 256) mn = 256; if (mx <= mn) mx = mn + 256;
  // no weapon + attack flag (0x6FCFC6A7): strength is added as damage %; MonEquip pets may carry a weapon instead
  const equip = ['valkyrie', 'shadowwarrior', 'shadowmaster', 'dopplezonnew'].includes(monName);
  if (equip) notes.push(monName + ' gets MonEquip items (0x6FCB2ED0, random magic/rare by equip level): with a weapon the damage is the weapon\'s + StrBonus/DexBonus, not modelled');
  const ed = Math.max(-90, (S.damagepercent || 0) + (S.strength || 0));
  mn += pctOf(mn, ed); mx += pctOf(mx, ed);
  out.level = level;
  out.lifeMin = hpMin >> 8; out.lifeMax = hpMax >> 8; out.life = (out.lifeMin + out.lifeMax) >> 1;
  out.dmgMin = mn >> 8; out.dmgMax = mx >> 8;
  const dex = S.dexterity || 0;
  out.ar = ar + 5 * dex;                                             // hit roll 0x6FCFDE90: monster AR = T19 + 5*dex, x (100+T119)
  // defense #10672: (T31 + dex/4) * (100 + T16 + T171) / 100
  const b = (S.armorclass || 0) + tdiv(dex, 4), p = (S.item_armor_percent || 0) + (S.skill_armor_percent || 0);
  out.def = b > 0 ? b + tdiv(b * p, 100) : b - tdiv(b * p, 100);
  out.res = {}; for (const k in RES) out.res[k] = S[RES[k]] || 0;
  out.elem = {};
  for (const [e, a, z] of [['fire', 'firemindam', 'firemaxdam'], ['cold', 'coldmindam', 'coldmaxdam'], ['light', 'lightmindam', 'lightmaxdam'], ['magic', 'magicmindam', 'magicmaxdam']])
    if (S[a] || S[z]) out.elem[e] = [S[a] || 0, S[z] || 0];
  // MonStats skills are added at spawn (0x6FCD01D6) at Sk*lvl (+ DifficultyLevels MonsterSkillBonus, not applied here);
  // a sumskill of the same id then sets its level (#10302)
  out.skills = skills.concat(mon.skills.filter(([n]) => !skills.some(x => x.skill === n)).map(([n, l]) => ({ skill: n, lvl: l, from: 'MonStats' })));
  out.stats = S;
  return out;
}

// ------------------------------------------------------------------ mercenaries
function hirelingRow(type, level, expansion) {                       // D2Common #11156 = 0x6FDA32C0
  const ver = expansion === false ? 0 : 100; let pick = null;
  for (const h of D.hireling) {
    if (h.Id !== type || h.Version !== ver) continue;
    if (!pick) pick = h; else if (h.Level <= level) pick = h; else break;
  }
  return pick;
}
function mercLevelFromExp(type, exp, expansion) {                    // D2Game 0x6FC75CF1 loop, #10448 = L*L*(L+1)*ExpLvl
  let L = 1;
  for (;;) {
    const r = hirelingRow(type, L, expansion); if (!r || L + 1 > 98) break;
    const need = (L + 1) * (L + 1) * (L + 2) * r.ExpLvl;
    if (exp < need) break; L++;
  }
  return L;
}
function resolveType(m) {
  if (m.type !== undefined) return m.type;
  const ver = m.expansion === false ? 0 : 100;
  const h = D.hireling.find(h => h.Version === ver && (m.class === undefined || h.Class === m.class) && (m.act === undefined || h.Act === m.act) &&
    (m.difficulty === undefined || h.Difficulty === m.difficulty + 1) && (m.subtype === undefined || h.SubType === m.subtype));
  return h ? h.Id : undefined;
}
function mercStats(m, T, o) {
  m = m || {}; T = T || {}; o = o || {};
  const type = resolveType(m); if (type === undefined) throw new Error('no hireling for ' + JSON.stringify(m));
  const level = m.level !== undefined ? m.level : mercLevelFromExp(type, m.experience || 0, m.expansion);
  const h = hirelingRow(type, level, m.expansion); if (!h) throw new Error('no Hireling row for type ' + type);
  const notes = [];
  const dl = level - h.Level;                                        // D2Game 0x6FC68BA0
  const base = {
    str: Math.max(10, h.Str + tdiv(h.StrLvl * dl, 8)), dex: Math.max(10, h.Dex + tdiv(h.DexLvl * dl, 8)),
    life: Math.max(40, h.HP + h.HPLvl * dl), def: Math.max(0, h.Def + h.DefLvl * dl), ar: Math.max(0, h.AR + h.ARLvl * dl),
    dmgMin: Math.max(0, h.DmgMin + tdiv(h.DmgLvl * dl, 8)), dmgMax: Math.max(1, h.DmgMax + tdiv(h.DmgLvl * dl, 8)),
    resist: Math.max(0, h.Resist + tdiv(h.ResistLvl * dl, 4))
  };
  const skills = [];
  for (const s of h.skills) {
    if (s.mode >= 16 || level < s.reqlevel) continue;
    let v = s.level + ((s.lvlperlvl * dl) >> 5);
    if (v <= 0) continue; if (v > 32) v = 32;
    skills.push({ skill: s.skill, id: s.id, mode: s.mode, base: v, chance: s.chance });
  }
  // unit totals: base list (hireling) + item/aura lists
  const tot = {};
  const add = (k, v) => { if (v) tot[k] = (tot[k] || 0) + v; };
  for (const k in T) { const name = /^\d+$/.test(k) ? D.stats[+k] : k; add(name, T[k] | 0); }
  // merc skill levels: base + non-player bonus (0x6FD9FCB0: allskills 127, oskill 97 capped at 3 when base>0, element 126 ...)
  for (const s of skills) s.lvl = s.base + statOf(tot, 'item_allskills');
  if (o.ownAuras !== false) {
    // merc's own aura (do-func 65, D2Game 0x6FCBA8D0): the owner gets aurastat1-6. Its passivestats are only added
    // when the owner's mana (stat 8) exceeds the mana cost (0x6FCBAA63, cost #10090 = (mana+lvlmana*(lvl-1))<<shift),
    // which a mercenary with no mana never does; the passivestate list (#10056) is removed while the aura runs.
    for (const s of skills) {
      const sk = D.skills[s.skill]; if (!sk || !sk.aurastat.length || s.mode !== 1) continue;
      const c = { sk, lvl: s.lvl, blvl: s.base, ulvl: level, T: tot, levelsOf: () => ({ lvl: 0, blvl: 0 }) };
      for (const [st, cc] of sk.aurastat) { const v = evalCalc(cc, c); if (v) add(st, v); }
      s.aura = true;
    }
  }
  // unit-level ops (0x6FD89530): 2/3 per level (level = merc level), 11 % of total; 8/9 (energy/vitality) only for players
  for (const [name, op] of Object.entries(D.iscOps)) {
    const v = tot[name]; if (!v) continue;
    if ((op.op === 2 || op.op === 3) && op.base === 'level') for (const t of op.stats) {
      if (op.op === 2) add(t, (v * level) >> op.param);
    }
  }
  const str = base.str + (tot.strength || 0), dex = base.dex + (tot.dexterity || 0);
  let life = base.life + (tot.maxhp || 0); life += tdiv(life * (tot.item_maxhp_percent || 0), 100);
  const b = base.def + (tot.armorclass || 0) + tdiv(dex, 4), p = (tot.item_armor_percent || 0) + (tot.skill_armor_percent || 0);
  const def = b > 0 ? b + tdiv(b * p, 100) : b - tdiv(b * p, 100);   // #10672
  const ar = base.ar + (tot.tohit || 0) + 5 * dex, arPct = tot.item_tohit_percent || 0;
  // damage as on the merc panel (D2Client 0x6FB3EA20)
  const w = o.weapon || null;
  const T21 = tot.mindamage || 0, T22 = tot.maxdamage || 0, T23 = base.dmgMin + (tot.secondary_mindamage || 0), T24 = base.dmgMax + (tot.secondary_maxdamage || 0);
  let minB = T21, maxB = T22, pct = tot.damagepercent || 0, flat = 0;
  if (w) {
    if (w.twoHanded) { minB = T21 - (w.min1 || 0) + T23; maxB = T22 - (w.max1 || 0) + T24; }
    pct += tdiv(str * (w.StrBonus || 0), 100) + tdiv(dex * (w.DexBonus || 0), 100);
    flat = w.normalDamage || 0;
    notes.push('mastery term (PD 0x102728B0) assumed 0 for mercs');
  } else pct += h.Class === 271 ? dex : str;
  if (pct < -90) pct = -90;
  let dmgMin = tdiv(minB * (100 + (tot.item_mindamage_percent || 0) + pct), 100) + flat;
  let dmgMax = tdiv(maxB * (100 + (tot.item_maxdamage_percent || 0) + pct), 100) + flat;
  for (const [a, z] of [['firemindam', 'firemaxdam'], ['lightmindam', 'lightmaxdam'], ['magicmindam', 'magicmaxdam'], ['coldmindam', 'coldmaxdam']]) { dmgMin += tot[a] || 0; dmgMax += tot[z] || 0; }
  if (tot.poisonmindam || tot.poisonmaxdam) {
    const len = tot.poisonlength || 0;
    dmgMin += (tot.poisonmindam || 0) * len >> 8; dmgMax += (tot.poisonmaxdam || 0) * len >> 8;
    notes.push('poison shown as (min|max * length) >> 8, poison_count ignored');
  }
  if (!w) notes.push('no weapon: panel uses stats 21/22 only; the hireling base damage lives in 23/24 and only shows with a two-handed weapon');
  const res = {}, resDisplay = {};
  const pen = D.difficultyResistPenalty[o.difficulty === undefined ? 2 : o.difficulty];
  for (const [k, st, mx] of [['fire', 'fireresist', 'maxfireresist'], ['cold', 'coldresist', 'maxcoldresist'], ['light', 'lightresist', 'maxlightresist'], ['poison', 'poisonresist', 'maxpoisonresist']]) {
    res[k] = base.resist + (tot[st] || 0);
    const cap = Math.min(75 + (tot[mx] || 0), 90);                 // PD2: 0x5F -> 0x5A at D2Client 0x6FB3EFA7/0x6FB3EFAD
    resDisplay[k] = Math.min(Math.max(res[k] + pen, -100), cap);
  }
  return { row: h.row, type, name: h.Hireling, subtype: h.SubType, act: h.Act, difficulty: h.Difficulty - 1, class: h.Class,
    level, rowLevel: h.Level, str, dex, life, def, ar, arPct, dmgMin, dmgMax, res, resDisplay, skills, base, notes };
}

const API = { setData, evalCalc, summonStats, mercStats, hirelingRow, mercLevelFromExp, dm, lvtier, parse, _kw: kw };
if (typeof module !== 'undefined' && module.exports) {
  module.exports = API;
  try { setData(JSON.parse(require('fs').readFileSync(require('path').join(__dirname, 'minions.json'), 'utf8'))); } catch (e) { /* caller sets data */ }
} else root.PD2Minions = API;
})(typeof window !== 'undefined' ? window : this);

/* ---- adv/engine/engine.js ---- */
/* PD2 Advanced Stats engine.
   Rebuilds a character's unit stats the way D2Common does, from either a PD2 Armory JSON or a decoded .d2s
   (PD2Save.parse), then derives every line of BH.dll's Advanced Stats panel plus extra stats.

   Game-code references (1.13c + ProjectDiablo.dll):
   - Stat totals and "op" links: D2Common 0x6FD89530 (ops 1-13), base-list getter 0x6FD88B00, all-lists sum 0x6FD88CD0,
     item totals propagate to the owner through 0x6FD89CE0 -> 0x6FD88940.
   - Skill calc keywords: SkillCalc.txt; ln = par + (lvl-1)*par (D2Common 0x6FD51690); dm = 0x6FD9DC30 (verified natively);
     level tiers for elemental values = 0x6FD9DDB0; blvl = skill base level +0x28 (0x6FDA14C6).
   - Advanced Stats panel: BH.dll 0x1007C040 (line-by-line mapping in panel()).
   Works in browsers (window.PD2Adv) and Node (module.exports). */
(function (root) {
'use strict';
const tdiv = (a, b) => (b ? Math.trunc(a / b) : 0);
const S = { strength: 0, energy: 1, dexterity: 2, vitality: 3, maxhp: 7, maxmana: 9, maxstamina: 11, level: 12 };

// ---------------------------------------------------------------- skill calc language
function lvtier(l, t) {                          // D2Common 0x6FD9DDB0
  if (l <= 1) return 0;
  if (l <= 8) return (l - 1) * t[0];
  if (l <= 16) return 7 * t[0] + (l - 8) * t[1];
  if (l <= 22) return 7 * t[0] + 8 * t[1] + (l - 16) * t[2];
  if (l <= 28) return 7 * t[0] + 8 * t[1] + 6 * t[2] + (l - 22) * t[3];
  return 7 * t[0] + 8 * t[1] + 6 * t[2] + 6 * t[3] + (l - 28) * t[4];
}
function lentier(l, t) {
  if (l <= 1) return 0;
  if (l <= 8) return (l - 1) * t[0];
  if (l <= 16) return 7 * t[0] + (l - 8) * t[1];
  return 7 * t[0] + 8 * t[1] + (l - 16) * t[2];
}
function dm(l, a, b) {                           // D2Common 0x6FD9DC30
  if (l <= 0) return 0;
  const t = tdiv(110 * l, l + 6); const v = tdiv(t * (b - a), 100) + a; return v > b ? b : v;
}
function tokenize(s) {
  const out = []; let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (/\s/.test(c)) { i++; continue; }
    if (/[0-9]/.test(c)) { let j = i; while (j < s.length && /[0-9.]/.test(s[j])) j++; out.push({ t: 'n', v: parseFloat(s.slice(i, j)) }); i = j; continue; }
    if (/[A-Za-z_]/.test(c)) { let j = i; while (j < s.length && /[A-Za-z_0-9]/.test(s[j])) j++; out.push({ t: 'id', v: s.slice(i, j) }); i = j; continue; }
    if (c === "'") { const j = s.indexOf("'", i + 1); out.push({ t: 's', v: s.slice(i + 1, j) }); i = j + 1; continue; }
    if (c === '"') { out.push({ t: 'p', v: '(' }); i++; while (i < s.length && s[i] !== '"') { const k = s.indexOf('"', i); const inner = s.slice(i, k); tokenize(inner).forEach(x => out.push(x)); i = k; } out.push({ t: 'p', v: ')' }); i++; continue; }
    const two = s.slice(i, i + 2);
    if (['<=', '>=', '==', '!='].includes(two)) { out.push({ t: 'o', v: two }); i += 2; continue; }
    out.push({ t: 'o', v: c }); i++;
  }
  return out;
}
function parseCalc(src) {
  const T = tokenize(String(src || '0')); let p = 0;
  const peek = () => T[p], take = () => T[p++];
  function primary() {
    const t = take();
    if (!t) return { k: 'n', v: 0 };
    if (t.t === 'n') return { k: 'n', v: t.v };
    if (t.v === '(') { const e = ternary(); take(); return e; }
    if (t.v === '-') return { k: 'neg', a: unary() };
    if (t.t === 'id') {
      if (peek() && peek().v === '(') {
        take(); const args = [];
        if (t.v === 'skill' || t.v === 'stat' || t.v === 'sklvl') {
          const name = take().v; let prop = null;
          if (peek() && peek().v === '.') { take(); prop = take().v; }
          while (peek() && peek().v !== ')') take();
          take(); return { k: t.v, name, prop };
        }
        while (peek() && peek().v !== ')') { args.push(ternary()); if (peek() && peek().v === ',') take(); }
        take(); return { k: 'fn', f: t.v, args };
      }
      return { k: 'id', v: t.v };
    }
    return { k: 'n', v: 0 };
  }
  function unary() { if (peek() && peek().v === '-') { take(); return { k: 'neg', a: unary() }; } if (peek() && peek().v === '+') { take(); return unary(); } return primary(); }
  function bin(next, ops) { return function () { let a = next(); while (peek() && ops.includes(peek().v)) { const o = take().v; a = { k: 'b', o, a, b: next() }; } return a; }; }
  const mul = bin(unary, ['*', '/']); const add = bin(mul, ['+', '-']); const cmp = bin(add, ['<', '>', '<=', '>=', '==', '!=']);
  function ternary() { const c = cmp(); if (peek() && peek().v === '?') { take(); const a = ternary(); take(); const b = ternary(); return { k: 't', c, a, b }; } return c; }
  return ternary();
}
const calcCache = new Map();
function evalCalc(src, ctx) {
  if (src === undefined || src === null || src === '') return 0;
  let ast = calcCache.get(src); if (!ast) { ast = parseCalc(src); calcCache.set(src, ast); }
  return Math.trunc(ev(ast, ctx));
}
function skillVal(sk, lvl, blvl, key, ctx) {   // one keyword evaluated for skill record sk at level lvl
  const P = sk.p;
  let m;
  if ((m = /^par([1-8])$/.exec(key))) return P[m[1] - 1];
  if ((m = /^ln([1-8])([1-8])$/.exec(key))) return lvl > 0 ? P[m[1] - 1] + (lvl - 1) * P[m[2] - 1] : 0;
  if ((m = /^dm([1-8])([1-8])$/.exec(key))) return dm(lvl, P[m[1] - 1], P[m[2] - 1]);
  switch (key) {
    case 'lvl': return lvl;
    case 'blvl': return blvl;
    case 'ulvl': return ctx.clvl;
    case 'edmn': case 'edns': case 'enma': case 'enms': {
      const v = ((sk.emin + lvtier(lvl, sk.eminl)) << sk.hs) + synergy(sk, ctx, ((sk.emin + lvtier(lvl, sk.eminl)) << sk.hs));
      return key === 'edns' || key === 'enms' ? v : v >> 8;
    }
    case 'edmx': case 'edxs': case 'exma': case 'exms': {
      const v = ((sk.emax + lvtier(lvl, sk.emaxl)) << sk.hs) + synergy(sk, ctx, ((sk.emax + lvtier(lvl, sk.emaxl)) << sk.hs));
      return key === 'edxs' || key === 'exms' ? v : v >> 8;
    }
    case 'edln': case 'edma': return sk.elen + lentier(lvl, sk.elenl);
    case 'toht': return lvl > 0 ? sk.th + (lvl - 1) * sk.lth : 0;
  }
  return 0;
}
function synergy(sk, ctx, base) {                  // EDmgSymPerCalc (D2Common 0x6FDA03C5): base * calc / 100
  if (!sk.sym) return 0;
  const pct = evalCalc(sk.sym, Object.assign({}, ctx, { sk, lvl: ctx.lvl, blvl: ctx.blvl }));
  return tdiv(base * pct, 100);
}
function ev(n, ctx) {
  switch (n.k) {
    case 'n': return n.v;
    case 'neg': return -ev(n.a, ctx);
    case 't': return ev(n.c, ctx) ? ev(n.a, ctx) : ev(n.b, ctx);
    case 'b': {
      const a = ev(n.a, ctx), b = ev(n.b, ctx);
      switch (n.o) {
        case '+': return a + b; case '-': return a - b; case '*': return a * b; case '/': return b ? Math.trunc(a / b) : 0;
        case '<': return +(a < b); case '>': return +(a > b); case '<=': return +(a <= b); case '>=': return +(a >= b);
        case '==': return +(a === b); case '!=': return +(a !== b);
      }
      return 0;
    }
    case 'fn': {
      const v = n.args.map(a => ev(a, ctx));
      if (n.f === 'min') return Math.min(...v); if (n.f === 'max') return Math.max(...v);
      return v[0] || 0;
    }
    case 'id': return skillVal(ctx.sk, ctx.lvl, ctx.blvl, n.v, ctx);
    case 'skill': {
      const id = ctx.D.skillByName[String(n.name).toLowerCase()];
      if (id === undefined) return 0;
      const sk = ctx.D.skills[id]; const L = ctx.levels ? ctx.levels(id) : { lvl: 0, blvl: 0 };
      return skillVal(sk, L.lvl, L.blvl, n.prop || 'lvl', Object.assign({}, ctx, { sk, lvl: L.lvl, blvl: L.blvl }));
    }
    case 'stat': {
      const id = ctx.D.statByName[n.name]; return id === undefined || !ctx.stat ? 0 : ctx.stat(id);
    }
    case 'sklvl': return 0;
  }
  return 0;
}

// ---------------------------------------------------------------- data prep
function prepare(D) {
  if (D._prepared) return D;
  D.statByName = {};
  for (const [id, s] of Object.entries(D.isc)) D.statByName[s.n] = +id;
  // op links: target stat -> list of {src, op, param, base}
  D.opLinks = {};
  for (const [id, s] of Object.entries(D.isc)) {
    if (!s.op) continue;
    for (const t of s.ops) (D.opLinks[t] = D.opLinks[t] || []).push({ src: +id, op: s.op, p: s.opp, base: s.opb });
  }
  for (const sk of Object.values(D.skills)) sk.sym = sk.sym || '';
  D._prepared = true;
  return D;
}
function isType(D, t, target, seen) {
  if (!t) return false; if (t === target) return true;
  seen = seen || new Set(); if (seen.has(t)) return false; seen.add(t);
  const r = D.types[t]; return !!r && r.eq.some(e => isType(D, e, target, seen));
}

// ---------------------------------------------------------------- input normalisation
const BODY = { 1: 'head', 2: 'neck', 3: 'tors', 4: 'rarm', 5: 'larm', 6: 'rrin', 7: 'lrin', 8: 'belt', 9: 'feet', 10: 'glov', 11: 'rarm2', 12: 'larm2' };
const ARMORY_EQ = { 'Helm': 'head', 'Amulet': 'neck', 'Armor': 'tors', 'Right Hand': 'rarm', 'Left Hand': 'larm', 'Right Ring': 'rrin', 'Left Ring': 'lrin', 'Belt': 'belt', 'Boots': 'feet', 'Gloves': 'glov', 'Right Hand Switch': 'rarm2', 'Left Hand Switch': 'larm2', 'Alternate Right Hand': 'rarm2', 'Alternate Left Hand': 'larm2' };
// Armory modifier names that stand for several stats
function armoryStats(D, mods) {
  const out = []; const id = n => D.statByName[n];
  const add = (n, v, param) => { const s = id(n); if (s !== undefined) out.push({ id: s, param: param || 0, val: v }); };
  for (const m of mods || []) {
    const v = m.values || []; const n = m.name;
    switch (n) {
      case 'all_resist': ['fireresist', 'coldresist', 'lightresist', 'poisonresist'].forEach(x => add(x, v[0])); break;
      case 'all_attributes': ['strength', 'energy', 'dexterity', 'vitality'].forEach(x => add(x, v[0])); break;
      case 'maxdamage_percent': add('item_maxdamage_percent', v[0]); add('item_mindamage_percent', v[1] !== undefined ? v[1] : v[0]); break;
      case 'min_damage': add('mindamage', v[0]); add('secondary_mindamage', v[0]); add('item_throw_mindamage', v[0]); break;
      case 'max_damage': add('maxdamage', v[0]); add('secondary_maxdamage', v[0]); add('item_throw_maxdamage', v[0]); break;
      case 'firedam': add('firemindam', v[0]); add('firemaxdam', v[1] !== undefined ? v[1] : v[0]); break;
      case 'lightdam': add('lightmindam', v[0]); add('lightmaxdam', v[1] !== undefined ? v[1] : v[0]); break;
      case 'magicdam': add('magicmindam', v[0]); add('magicmaxdam', v[1] !== undefined ? v[1] : v[0]); break;
      case 'magicmindam': add('magicmindam', v[0]); if (v.length > 1 && !mods.some(x => x.name === 'magicmaxdam')) add('magicmaxdam', v[1]); break;
      case 'colddam': add('coldmindam', v[0]); add('coldmaxdam', v[1]); if (v[2] !== undefined && !mods.some(x => x.name === 'coldlength')) add('coldlength', v[2]); break;
      case 'poisondam': case 'poisonmindam': add('poisonmindam', v[0]); add('poisonmaxdam', v[1]); if (v[2] !== undefined && !mods.some(x => x.name === 'poisonlength')) add('poisonlength', v[2]); break;
      case 'lightmindam': add('lightmindam', v[0]); if (v.length > 1 && !mods.some(x => x.name === 'lightmaxdam')) add('lightmaxdam', v[1]); break;
      case 'firemindam': add('firemindam', v[0]); if (v.length > 1 && !mods.some(x => x.name === 'firemaxdam')) add('firemaxdam', v[1]); break;
      case 'coldmindam': add('coldmindam', v[0]); if (v.length > 1 && !mods.some(x => x.name === 'coldmaxdam')) add('coldmaxdam', v[1]); break;
      case 'item_addclassskills': add(n, v[1], v[0]); break;
      case 'item_addskill_tab': add(n, v[1], v[0]); break;
      case 'item_singleskill': case 'item_nonclassskill': case 'item_aura': case 'item_skillonequip': add(n, v[1], v[0]); break;
      case 'item_elemskill_fire': case 'item_elemskill_cold': case 'item_elemskill_lightning': case 'item_elemskill_poison': case 'item_elemskill_magic': case 'item_elemskill':
        add(n, v[v.length - 1], v.length > 1 ? v[0] : 0); break;
      case 'item_charged_skill': add(n, v[2] | (v[3] << 8), (v[1] << 6) | v[0]); break;
      case 'item_skillonhit': case 'item_skillonattack': case 'item_skillongethit': case 'item_skillonkill': case 'item_skillondeath':
      case 'item_skillonlevelup': case 'item_skilloncast': case 'item_skillonblock': case 'item_skillonpierce': case 'item_splashonhit': case 'item_skilloncrit':
        add(n, v[2], (v[1] << 6) | v[0]); break;
      case 'item_reanimate': add(n, v[1], v[0]); break;
      case 'corrupted': case 'desecrated': case 'desecrator': add(n, v[v.length - 1] || 0); break;
      default: {
        const s = id(n);
        if (s === undefined) { out.push({ unknown: n, val: v[0] }); break; }
        const isc = D.isc[s];
        let val = v[0];
        // per-level stats are shown divided by 2^param; the stored value is what the op uses
        if (isc && (isc.op === 2 || isc.op === 4 || isc.op === 5) && isc.opb === S.level) val = Math.round(val * (1 << isc.opp));
        out.push({ id: s, param: v.length > 1 ? v[0] : 0, val: v.length > 1 ? v[1] : val });
      }
    }
  }
  return out;
}
function fromArmory(J, D) {
  prepare(D);
  const C = J.character;
  const model = {
    source: 'armory', name: C.name, cls: C.class.id, level: C.level, hardcore: C.status.is_hardcore, ladder: C.status.is_ladder,
    exp: C.experience >>> 0, gold: C.gold.character, goldbank: C.gold.stash,
    base: { strength: C.attributes.strength, dexterity: C.attributes.dexterity, vitality: C.attributes.vitality, energy: C.attributes.energy,
            maxhp: C.life, maxmana: C.mana, maxstamina: C.stamina },
    skills: {}, items: [], merc: null,
  };
  for (const s of C.skills || []) if (s.level) model.skills[s.id] = s.level;
  const conv = (it) => {
    const r = {
      name: it.name, code: it.base_code || it.base.id, type: it.base.type_code, quality: it.quality && it.quality.id, eth: !!it.is_ethereal,
      stats: armoryStats(D, it.modifiers), rw: it.runeword ? it.runeword.name : null, runewordStats: [],
      sockets: it.socket_count || 0, children: (it.socketed || []).map(conv), setName: it.quality && it.quality.id === 5 ? it.name : null,
      defense: it.defense ? it.defense.base : null, defenseTotal: it.defense ? it.defense.total : null,
      armoryDamage: it.damage || null, unique: it.quality && it.quality.id === 7 ? it.name : null, ilvl: it.item_level,
      corrupted: !!it.corrupted, loc: 'other', slot: null, x: it.position ? it.position.column : 0, y: it.position ? it.position.row : 0,
      childrenIncluded: true, labels: (it.modifiers || []).map(m => m.label).filter(x => typeof x === 'string' && x),        // the Armory folds socketed runes/jewels into the parent's modifier list
    };
    const L = it.location || {};
    if (L.zone === 'Equipped') { r.loc = 'equip'; r.slot = ARMORY_EQ[L.equipment] || ('eq' + L.equipment_id); }
    else if (L.storage === 'Inventory') r.loc = 'inv';
    else if (L.storage === 'Stash') r.loc = 'stash';
    else if (L.storage === 'Cube') r.loc = 'cube';
    else if (L.zone === 'Belt' || L.storage === 'Belt') r.loc = 'belt';
    return r;
  };
  model.items = (J.items || []).map(conv);
  if (J.mercenary && J.mercenary.items) model.merc = { type: J.mercenary.type, name: J.mercenary.name, desc: J.mercenary.description, level: J.mercenary.level, experience: J.mercenary.experience, items: J.mercenary.items.map(conv) };
  return model;
}
function fromSave(P, D) {
  prepare(D);
  const A = P.attributes;
  const model = {
    source: 'save', name: P.name, cls: P.class.id, level: P.level, hardcore: P.hardcore, ladder: P.ladder,
    exp: A.experience, gold: A.gold, goldbank: A.goldbank,
    base: { strength: A.strength, dexterity: A.dexterity, vitality: A.vitality, energy: A.energy, maxhp: A.maxhp, maxmana: A.maxmana, maxstamina: A.maxstamina },
    skills: {}, items: [], merc: null, warnings: P.warnings || [],
  };
  for (const s of P.skills || []) if (s.level) model.skills[s.id] = s.level;
  const conv = (it) => {
    const L = it.location || {};
    const r = {
      name: it.unique_name || it.set_name || (it.runeword && it.runeword.name) || it.name, code: it.code, type: it.type, quality: it.quality, eth: !!it.ethereal,
      stats: (it.stats || []).map(s => ({ id: s.id, param: s.param || 0, val: s.values[0], vals: s.values })),
      runewordStats: (it.runeword_stats || []).map(s => ({ id: s.id, param: s.param || 0, val: s.values[0], vals: s.values })),
      setBonusLists: (it.set_bonus_lists || []).map(l => ({ bit: l.mask_bit, stats: l.stats.map(s => ({ id: s.id, param: s.param || 0, val: s.values[0] })) })),
      rw: it.runeword ? it.runeword.name : null, sockets: it.sockets || 0, children: (it.socketed || []).map(conv),
      setId: it.set_id, setName: it.set_item ? it.set_item[0] : null, defense: it.defense, unique: it.unique_name || null,
      ilvl: it.ilvl, loc: 'other', slot: null, x: L.x, y: L.y, quantity: it.quantity,
    };
    if (L.parent === 'equipped') { r.loc = 'equip'; r.slot = BODY[L.bodyloc] || L.bodyloc_code; }
    else if (L.storage === 'inventory') r.loc = 'inv';
    else if (L.storage === 'stash') r.loc = 'stash';
    else if (L.storage === 'cube') r.loc = 'cube';
    else if (L.parent === 'belt') r.loc = 'belt';
    return r;
  };
  model.items = (P.items || []).map(conv);
  if (P.mercenary && P.mercenary.items && P.mercenary.exists !== false) model.merc = { type: P.mercenary.type, experience: P.mercenary.experience, items: P.mercenary.items.map(conv) };
  return model;
}

// ---------------------------------------------------------------- item stat lists
function propStats(D, code, param, min, max, ctx) {   // Properties.txt -> stats (used for set bonuses and gem mods)
  const pr = D.props[code]; if (!pr) return [];
  const out = []; const val = max !== undefined && max !== null && max !== 0 && max > min ? max : min;
  for (const [func, stat, set, v] of pr) {
    const p = parseInt(param, 10);
    switch (func) {
      case 1: case 2: case 3: case 4: case 8: out.push({ id: stat, param: 0, val }); break;
      case 5: out.push({ id: 21, param: 0, val }); out.push({ id: 23, param: 0, val }); out.push({ id: 159, param: 0, val }); break;
      case 6: out.push({ id: 22, param: 0, val }); out.push({ id: 24, param: 0, val }); out.push({ id: 160, param: 0, val }); break;
      case 7: out.push({ id: 17, param: 0, val }); out.push({ id: 18, param: 0, val }); break;
      case 17: out.push({ id: stat, param: 0, val: isNaN(p) ? val : p }); break;        // per-level: parameter carries the rate
      case 21: out.push({ id: stat, param: v, val }); break;
      case 10: case 22: out.push({ id: stat, param: isNaN(p) ? (D.skillByName[String(param).toLowerCase()] || 0) : p, val }); break;
      case 11: case 19: case 24: break;                                           // events / charges: no stat totals
      case 12: case 36: break;
      case 15: out.push({ id: stat, param: 0, val: min }); break;
      case 16: out.push({ id: stat, param: 0, val: max }); break;
      default: if (stat >= 0) out.push({ id: stat, param: isNaN(p) ? 0 : p, val });
    }
  }
  return out.filter(s => s.id >= 0);
}
function socketStats(D, parent, child) {      // gems/runes get their mods from Gems.txt by parent class (.d2s only)
  if (child.stats && child.stats.length) return child.stats;
  const g = D.gems[child.code]; if (!g) return [];
  const base = D.items[parent.code]; const t = base ? base.t : parent.type;
  const part = base && base.c === 'weapon' ? 'weapon' : (isType(D, t, 'shld') ? 'shield' : 'helm');
  const out = []; for (const [c, p, mn, mx] of g[part]) out.push(...propStats(D, c, p, mn, mx));
  return out;
}
function itemBase(D, it, model) {            // the item's own base list: defense, damage, durability (set at creation)
  const b = D.items[it.code]; const out = [];
  if (!b) return out;
  if (b.c === 'armor' || (b.ac1 && b.c !== 'weapon')) {
    const def = it.defense !== null && it.defense !== undefined ? it.defense : 0;
    if (def) out.push({ id: 31, param: 0, val: def });
  }
  if (b.c === 'weapon') {
    const eth = it.eth ? 3 / 2 : 1;
    const f = v => Math.trunc(v * eth);
    if (b.min || b.max) { out.push({ id: 21, param: 0, val: f(b.min) }); out.push({ id: 22, param: 0, val: f(b.max) }); }
    if (b.min2 || b.max2) { out.push({ id: 23, param: 0, val: f(b.min2) }); out.push({ id: 24, param: 0, val: f(b.max2) }); }
    if (b.tmin || b.tmax) { out.push({ id: 159, param: 0, val: f(b.tmin) }); out.push({ id: 160, param: 0, val: f(b.tmax) }); }
    out.push({ id: 68, param: 0, val: -b.sp });                   // attackrate: -WSM (D2Common 0x6FD7AEB6)
  }
  if (b.c === 'armor' && b.blk) out.push({ id: 20, param: 0, val: b.blk });
  if (b.c === 'armor' && b.sp) out.push({ id: 67, param: 0, val: -b.sp });       // armor/shield speed penalty (D2Common 0x6FD7ADD9)
  return out;
}
class List {                                   // stat id+param -> value
  constructor() { this.m = new Map(); }
  add(id, param, v) { const k = id * 65536 + (param & 0xffff); this.m.set(k, (this.m.get(k) || 0) + v); }
  get(id, param) { return this.m.get(id * 65536 + ((param || 0) & 0xffff)) || 0; }
  sum(id) { let t = 0; for (const [k, v] of this.m) if (Math.floor(k / 65536) === id) t += v; return t; }
  each(fn) { for (const [k, v] of this.m) fn(Math.floor(k / 65536), k % 65536, v); }
}
function vshift(D, id, v) { const r = D.isc[id]; return r && r.vs ? v * (1 << r.vs) : v; }
function itemTotals(D, it, model, parent) {   // item unit: base list + affix lists, with item-level ops (4, 5, 13)
  const base = new List(), all = new List();
  for (const s of itemBase(D, it, model)) { base.add(s.id, s.param, s.val); all.add(s.id, s.param, s.val); }
  const aff = [...(it.stats || []), ...(it.runewordStats || [])];
  if (!it.childrenIncluded) for (const ch of it.children || []) aff.push(...socketStats(D, it, ch));
  // item lists hold life/mana/stamina as whole points; the game stores them << ValShift (8) when it reads the item
  for (const s of aff) if (s.id !== undefined && s.id >= 0) all.add(s.id, s.param, vshift(D, s.id, s.val));
  const out = new List(); all.each((id, p, v) => out.add(id, p, v));
  // item-level ops (owner type 4): 13 = % of the item's base value, 4/5 = per owner level
  all.each((src, p, v) => {
    const s = D.isc[src]; if (!s || !s.op) return;
    for (const t of s.ops) {
      if (s.op === 13) { const b = base.get(t, 0); if (b) out.add(t, 0, tdiv(b * v, 100)); }
      else if (s.op === 4 && s.opb === S.level) out.add(t, 0, (v * model.level) >> s.opp);
      else if (s.op === 5 && s.opb === S.level) { const b = base.get(t, 0); out.add(t, 0, tdiv(((v * model.level) >> s.opp) * b, 100)); }
    }
  });
  // item_armor_percent etc. already applied; per-owner-level armor done
  return out;
}

// ---------------------------------------------------------------- the character
function isCharm(D, it) { const b = D.items[it.code]; return !!b && isType(D, b.t, 'char'); }
function weaponOf(D, model, swap) {
  const r = model.items.find(i => i.loc === 'equip' && i.slot === (swap ? 'rarm2' : 'rarm'));
  const l = model.items.find(i => i.loc === 'equip' && i.slot === (swap ? 'larm2' : 'larm'));
  const w = [r, l].filter(x => x && D.items[x.code] && D.items[x.code].c === 'weapon');
  return { right: r || null, left: l || null, weapons: w };
}
function activeItems(D, model, opts) {
  const swap = !!opts.swap; const out = [];
  for (const it of model.items) {
    if (it.loc === 'equip') {
      const s = it.slot;
      if (s === 'rarm' || s === 'larm') { if (!swap) out.push(it); }
      else if (s === 'rarm2' || s === 'larm2') { if (swap) out.push(it); }
      else out.push(it);
    } else if (it.loc === 'inv' && isCharm(D, it)) out.push(it);
  }
  return out;
}
function setBonuses(D, items) {              // SetItems aprop by count + Sets partial/full bonuses
  const bySet = new Map(); const out = [];
  for (const it of items) {
    if (it.quality !== 5) continue;
    let sid = it.setId;
    if ((sid === undefined || sid === null) && it.setName) sid = D.setitems.findIndex(s => s.n === it.setName);
    if (sid === undefined || sid < 0 || !D.setitems[sid]) continue;
    const si = D.setitems[sid]; const set = si.set;
    if (!bySet.has(set)) bySet.set(set, []);
    if (!bySet.get(set).some(x => x.si === si)) bySet.get(set).push({ it, si });   // the same set item twice counts once
  }
  for (const [set, list] of bySet) {
    const n = list.length;
    for (const { it, si } of list) {
      if (it.setBonusLists && it.setBonusLists.length) {      // .d2s stores the item's own bonus lists
        for (const l of it.setBonusLists) if (n >= l.bit + 2) for (const s of l.stats) out.push({ ...s, src: it.name + ' (set bonus)' });
        continue;
      }
      for (let k = 1; k <= 5; k++) if (n >= k + 1) for (const [c, p, mn, mx] of si.ap[k] || []) propStats(D, c, p, mn, mx).forEach(s => out.push({ ...s, src: it.name + ' (' + (k + 1) + ' items)' }));
    }
    const S2 = D.sets[set]; if (!S2) continue;
    for (let k = 2; k <= 5; k++) if (n >= k) for (const [c, p, mn, mx] of S2.part[k] || []) propStats(D, c, p, mn, mx).forEach(s => out.push({ ...s, src: S2.n + ' (' + k + ' items)' }));
    const total = D.setitems.filter(s => s.set === set).length;
    if (n >= total && total > 0) for (const [c, p, mn, mx] of S2.full) propStats(D, c, p, mn, mx).forEach(s => out.push({ ...s, src: S2.n + ' (full set)' }));
  }
  return out;
}
function skillLevels(D, model, U) {          // hard + item bonuses, as D2 applies them to learned skills; oskills add on top
  const cls = model.cls;
  const all = U.sum(127), clsb = U.get(83, cls);
  const cache = new Map();
  return function (id) {
    if (cache.has(id)) return cache.get(id);
    const sk = D.skills[id]; const hard = model.skills[id] || 0;
    let lvl = 0;
    if (sk) {
      if (sk.cl === cls && hard > 0) {
        lvl = hard + all + clsb + U.get(188, cls * 8 + (sk.tab - 1)) + U.get(107, id);
        const el = { fire: 363, cold: 362, ltng: 364, pois: 365, mag: 366 }[sk.et];
        if (el) lvl += U.sum(el);
      }
      lvl += U.get(97, id);                        // item_nonclassskill (oskill)
    }
    const r = { lvl, blvl: hard };
    cache.set(id, r); return r;
  };
}

function compute(model, D, opts) {
  prepare(D); opts = opts || {};
  const cls = D.classes[model.cls];
  const items = activeItems(D, model, opts);
  const src = new Map();                                        // stat id -> [{src, val}]
  const note = (id, name, v) => { if (!v) return; if (!src.has(id)) src.set(id, []); src.get(id).push({ src: name, val: v }); };
  // raw sum of every list (D2Common 0x6FD88CD0): base, item totals, set bonuses, skill lists
  const R = new List();
  const base = new List();
  const b = model.base;
  const put = (id, v, name) => { base.add(id, 0, v); R.add(id, 0, v); note(id, name, v); };
  put(0, b.strength, 'Base (stat points)'); put(1, b.energy, 'Base (stat points)'); put(2, b.dexterity, 'Base (stat points)'); put(3, b.vitality, 'Base (stat points)');
  put(7, Math.round(b.maxhp * 256), 'Base life'); put(9, Math.round(b.maxmana * 256), 'Base mana'); put(11, Math.round(b.maxstamina * 256), 'Base stamina');
  put(12, model.level, 'Character level'); put(68, 100, 'Base attack rate');
  put(15, model.goldbank || 0, 'Stash'); put(14, model.gold || 0, 'Inventory');
  const itemLists = [];
  for (const it of items) {
    const T = itemTotals(D, it, model);
    itemLists.push({ it, T });
    T.each((id, p, v) => { R.add(id, p, v); note(id, it.name + (it.loc === 'inv' ? ' (charm)' : ''), v); });
  }
  for (const s of setBonuses(D, items)) { const v = vshift(D, s.id, s.val); R.add(s.id, s.param, v); note(s.id, s.src, v); }
  // PD2: items grant auras and "when equipped" self-auras
  const auraSkills = [];
  R.each((id, p, v) => { if ((id === 151 || id === 191) && v > 0) auraSkills.push({ id: p, lvl: v, from: id === 191 ? 'equip' : 'aura' }); });
  // skill passives (need levels, which depend on +skills) and auras
  const levels = skillLevels(D, model, R);
  const W = weaponOf(D, model, !!opts.swap);
  const wType = W.weapons[0] ? D.items[W.weapons[0].code].t : null;
  const passiveCtx = (sk, L) => ({ D, sk, lvl: L.lvl, blvl: L.blvl, clvl: model.level, levels, stat: id => R.sum(id) });
  const skillRows = [];
  // Passive stats: D2Common #10056 (0x6FDA2480) builds a skill's passivestat list whenever the unit has the skill and the
  // skill has a passivestate (gated on passivestate, not on the 'passive' column). It stores the stats with
  // param = passiveitype rather than gating them on the weapon, so they count whatever is equipped (masteries are
  // matched later where the attack code asks for a specific param, see masteryStat()).
  const hasLevel = id => levels(id).lvl > 0;
  for (const [idStr, sk] of Object.entries(D.skills)) {
    const id = +idStr; if (!sk.pst || !sk.ps.length) continue;
    const L = levels(id); if (!L.lvl) continue;
    const matches = !sk.pit || !!(wType && isType(D, wType, sk.pit));
    const rows = [];
    for (const [stat, calc] of sk.ps) {
      if (stat < 0) continue;
      const v = evalCalc(calc, passiveCtx(sk, L));
      R.add(stat, 0, v); note(stat, (sk.dn || sk.n) + ' ' + L.lvl + ' (passive)', v); rows.push([stat, v]);
    }
    skillRows.push({ id, name: sk.dn || sk.n, lvl: L.lvl, active: true, weaponMatch: matches, itype: sk.pit, rows });
  }
  // Auras and buffs on the owner (adv/re/auras.md): which stat columns the owner gets depends on the skill's srvdofunc.
  //   65 (Might, Prayer, Fanaticism...): aurastats + passivestats (PD2 NOPs the stock passivestate test at 0x6FCBAA75)
  //   66/81 (Holy Fire/Freeze/Shock, Conviction, Sanctuary): passivestats only; 18 (armors, Quickness, Fade, Holy Shield):
  //   aurastats + passivestats; 23/47: passivestats; 68 (BO/BC/Shout), 25 (Enchant), 116/120 (forms, Feral Rage), 9: aurastats.
  // Item auras (151) and equipped skills (191) run the same code at the item's level; blvl = the owner's hard points.
  // One stat list per state: two sources of the same state never stack (the last applied wins; item auras re-apply).
  const AU = (typeof require === 'function' && typeof module !== 'undefined') ? require('../re/auras.js') : root.PD2Auras;
  const cand = [];
  for (const a of auraSkills) cand.push({ id: a.id, lvl: a.lvl, blvl: model.skills[a.id] || 0, from: a.from === 'equip' ? 'item (when equipped)' : 'item aura', item: true });
  for (const b of opts.buffs || []) {
    const L = levels(b.id); const lvl = b.lvl !== undefined ? b.lvl : L.lvl; if (!lvl) continue;
    cand.push({ id: b.id, lvl, blvl: b.blvl !== undefined ? b.blvl : L.blvl, from: 'active skill', item: false });
  }
  const byState = new Map();
  for (const c of cand) {
    const sk = D.skills[c.id]; if (!sk) continue;
    const key = sk.ast || ('skill' + c.id);
    const prev = byState.get(key);
    if (!prev || (c.item && !prev.item) || (c.item === prev.item && c.lvl > prev.lvl)) byState.set(key, c);
  }
  const auraRows = [];
  for (const c of byState.values()) {
    const sk = D.skills[c.id];
    const kinds = AU ? AU.selfBuffStats(Object.assign({ id: c.id }, sk), c.lvl, c.blvl, { id: c.id }).map(x => x.which) : ['aura'];
    const L = { lvl: c.lvl, blvl: c.blvl };
    const rows = [];
    // stats with the ItemStatCost 'direct' behaviour (current life/mana/stamina, e.g. Prayer's heal) change the pool, not a total
    const addCols = (list, tag) => { for (const [stat, calc] of list) { if (stat < 0 || stat === 6 || stat === 8 || stat === 10) continue; const v = evalCalc(calc, passiveCtx(sk, L)); if (!v) continue; R.add(stat, 0, v); note(stat, (sk.dn || sk.n) + ' ' + c.lvl + ' (' + tag + ')', v); rows.push([stat, v]); } };
    if (kinds.includes('aura')) addCols(sk.as, sk.aura ? 'aura' : 'buff');
    // a passivestate skill the unit owns already has its passivestats from #10056 (they move to the aura list, never doubled)
    if (kinds.includes('passive') && !(sk.pst && hasLevel(c.id))) addCols(sk.ps, sk.aura ? 'aura' : 'buff');
    auraRows.push({ id: c.id, name: sk.dn || sk.n, lvl: c.lvl, blvl: c.blvl, rows, from: c.from, kinds });
  }
  // auras from party members / a mercenary: auratargetstate with aurastat1-6 only, evaluated with the caster
  for (const a of opts.partyAuras || []) {
    const sk = D.skills[a.id]; if (!sk || !a.lvl) continue;
    const L = { lvl: a.lvl, blvl: a.blvl || 0 }; const rows = [];
    for (const [stat, calc] of sk.as) { if (stat < 0 || stat === 6 || stat === 8 || stat === 10) continue; const v = evalCalc(calc, passiveCtx(sk, L)); if (!v) continue; R.add(stat, 0, v); note(stat, (sk.dn || sk.n) + ' ' + a.lvl + ' (' + (a.src || 'party aura') + ')', v); rows.push([stat, v]); }
    auraRows.push({ id: a.id, name: sk.dn || sk.n, lvl: a.lvl, rows, from: a.src || 'party', kinds: ['aura'] });
  }
  // unit-level ops (owner type 0): 1, 2, 3, 8, 9, 11 (D2Common 0x6FD89530)
  const memo = new Map();
  const T = (id) => {
    if (memo.has(id)) return memo.get(id);
    memo.set(id, R.sum(id));
    let v = R.sum(id); const v0 = v;
    for (const L of D.opLinks[id] || []) {
      const s = T(L.src); if (!s) continue;
      switch (L.op) {
        case 1: case 11: if (v0) v += tdiv(s * v0, 100); break;
        case 2: { const bv = L.base >= 0 ? base.get(L.base, 0) : 0; if (bv > 0) v += (s * bv) >> L.p; break; }
        case 3: { const bv = L.base >= 0 ? base.get(L.base, 0) : 0; if (bv > 0) v += tdiv(((s * bv) >> L.p) * v0, 100); break; }
        case 8: { const bonus = s - base.get(L.src, 0); if (bonus) v += (cls.ManaPerMagic * bonus) << 6; break; }
        case 9: { const bonus = s - base.get(L.src, 0); if (bonus) v += ((id === 11 ? cls.StaminaPerVitality : cls.LifePerVitality) * bonus) << 6; break; }
      }
    }
    memo.set(id, v); return v;
  };
  const stat = id => T(id);
  return { model, D, cls, items, itemLists, R, T: stat, src, levels, skillRows, auraRows, weapons: W, opts };
}

// ---------------------------------------------------------------- BH.dll Advanced Stats panel (0x1007C040)
const OW_TABLE = [9, 18, 27, 36, 45];
function owBase(lvl) {                         // D2Game 0x6FCCC940 (per-frame open wounds base by level)
  const t = OW_TABLE; if (lvl <= 1) return 0;
  if (lvl <= 15) return (lvl - 1) * t[0];
  if (lvl <= 30) return 14 * t[0] + (lvl - 15) * t[1];
  if (lvl <= 45) return 14 * t[0] + 15 * t[1] + (lvl - 30) * t[2];
  if (lvl <= 60) return 14 * t[0] + 15 * (t[1] + t[2]) + (lvl - 45) * t[3];
  return 14 * t[0] + 15 * (t[1] + t[2] + t[3]) + (lvl - 60) * t[4];
}
function masteryStat(C, statKey, skillId) {   // BH 0x10079670: a mastery's value when the equipped weapon matches it
  const D = C.D; const sk = D.skills[skillId]; if (!sk) return 0;
  const L = C.levels(skillId); if (!L.lvl) return 0;
  const w = C.weapons.weapons[0]; const t = w ? D.items[w.code].t : null;
  if (sk.pit && !(t && isType(D, t, sk.pit))) return 0;
  const want = { crit: [344, 347, 337], cb: [136], cbe: [268], critmult: [256] }[statKey];
  let v = 0;
  for (const [stat, calc] of sk.ps) if (want.includes(stat)) v += evalCalc(calc, { D, sk, lvl: L.lvl, blvl: L.blvl, clvl: C.model.level, levels: C.levels, stat: C.T });
  return v;
}
function panel(C, opts) {
  opts = opts || {}; const T = C.T; const D = C.D; const m = C.model;
  const diff = opts.difficulty === undefined ? 2 : opts.difficulty;
  const pen = [0, -20, -50][diff] * 2;                             // BH: {0,-20,-50}[difficulty] * (expansion ? 2 : 1)
  const maxRes = s => Math.min(T(s) + 75, 90);
  const P = {};
  P.level = m.level; P.addxp = T(85);
  P.fire = { cur: T(39) + pen, max: maxRes(40) };
  P.cold = { cur: T(43) + pen, max: maxRes(44), len: T(153) > 0 ? 0 : (2 - Math.min(T(118), 2)) * 50 };
  P.light = { cur: T(41) + pen, max: maxRes(42) };
  P.poison = { cur: T(45) + pen, max: maxRes(46), len: 100 - T(110) - pen };
  P.curse = { cur: Math.min(T(504), 75), max: 75, len: Math.max(100 - T(109), 25) };
  P.absorb = { fire: [T(143), T(142)], cold: [T(149), T(148)], light: [T(145), T(144)], magic: [T(147), T(146)] };
  P.dr = { phys: [T(34), T(36)], magic: [T(35), T(37)] };
  P.thorns = { phys: T(78), light: T(128) };
  P.mastery = { fire: T(329), cold: T(331), light: T(330), poison: T(332), magic: T(357) };
  P.pierce = { fire: T(333), cold: T(335), light: T(334), poison: T(336), magic: T(358) };
  const dex = T(2);
  const arDex = C.cls.ToHitFactor + 5 * (dex - 7);
  P.ar = { dex: arDex, equip: T(19), total: arDex + T(19) };
  P.def = { dex: tdiv(dex, 4), equip: T(31), total: tdiv(dex, 4) + T(31) };
  P.dmg = { one: [T(21), T(22)], two: [T(23), T(24)] };
  P.fcr = T(105); P.fbr = T(102); P.fhr = T(99); P.frw = T(96); P.attackrate = T(68); P.ias = T(93);
  // crushing blow: Two-Hand Mastery (134) + items; efficiency 100 + mastery + items
  P.cb = { chance: masteryStat(C, 'cb', 134) + T(136), eff: masteryStat(C, 'cbe', 134) + T(268) + 100 };
  P.ow = { chance: T(135), dps: T(501) + ((owBase(m.level) + 25) * 25 >> 8) };
  const dsCap = Math.min(T(210) + 75, 100);
  P.ds = { chance: Math.min(T(141), dsCap), cap: dsCap, mult: T(257) + 150 };
  P.crit = { chance: Math.min(masteryStat(C, 'crit', 252) + masteryStat(C, 'crit', 135) + masteryStat(C, 'crit', 128) + T(337) + T(258), 75), cap: 75, mult: masteryStat(C, 'critmult', 19) + T(256) + 200 };
  P.ll = T(60); P.ml = T(62); P.pierceChance = T(166) + T(156);
  P.perKill = { life: T(86), mana: T(138) };
  const withMast = (v, mst) => v + Math.trunc(v * mst / 100);
  P.added = {
    phys: T(111),
    magic: [withMast(T(52), T(357)), withMast(T(53), T(357))],
    fire: [withMast(T(48), T(329)), withMast(T(49), T(329))],
    cold: [withMast(T(54), T(331)), withMast(T(55), T(331))],
    light: [withMast(T(50), T(330)), withMast(T(51), T(330))],
  };
  const plen = T(101) > 0 ? T(101) : T(59);
  P.added.poison = { min: Math.trunc(withMast(T(57), T(332)) / 256 * plen), max: Math.trunc(withMast(T(58), T(332)) / 256 * plen), secs: plen / 25 };
  P.mf = T(80); P.gf = T(79); P.stashGold = T(15);
  return P;
}

// ---------------------------------------------------------------- extra stats (beyond the panel)
function extras(C, opts) {
  const T = C.T; const D = C.D; const m = C.model; const cls = C.cls; opts = opts || {};
  const X = {};
  X.life = T(7) / 256; X.mana = T(9) / 256; X.stamina = T(11) / 256;
  X.str = T(0); X.dex = T(2); X.vit = T(3); X.ene = T(1);
  X.lifeRegen = T(74); X.manaRegen = T(27); X.stamRegen = T(28);
  X.ar = null; X.defense = T(31) + tdiv(T(2), 4);
  X.defMelee = T(33); X.defMissile = T(32);
  X.enhancedDef = T(16); X.skillArmor = T(171);
  X.lightRadius = T(89); X.reqPct = T(91);
  X.skillsAll = T(127); X.dmgToMana = T(114); X.slow = T(150); X.knockback = T(81);
  X.cbf = T(153) > 0; X.halfFreeze = T(118) > 0; X.poisonLen = T(110); X.curseRes = T(109);
  X.prevHeal = T(117) > 0; X.ignoreDef = T(115) > 0; X.targetDef = T(116); X.maxDs = T(210);
  X.dmgPct = T(25) + T(17); X.arPct = T(119); X.demonDmg = T(121); X.undeadDmg = T(122);
  X.lifeAfterHit = T(424); X.mfPerLevel = null; X.reducedPrices = T(87); X.addXp = T(85);
  X.extraSummons = { golem: T(476), spirits: T(459), skeWar: T(461), skeMage: T(462), hydra: T(463), valk: T(464) };
  X.maxCurses = T(368); X.curseEff = T(504);
  // block (D2Game block roll): (toblock + shield) * (dex - 15) / (clvl * 2), capped 75 (read; see notes)
  const shield = C.weapons.left && D.items[C.weapons.left.code] && D.items[C.weapons.left.code].c === 'armor' ? C.weapons.left : null;
  X.hasShield = !!shield;
  return X;
}

const API = { itemTotals, prepare, fromArmory, fromSave, compute, panel, extras, evalCalc, dm, lvtier, owBase, isType };
if (typeof module !== 'undefined' && module.exports) module.exports = API; else root.PD2Adv = API;
})(typeof window !== 'undefined' ? window : globalThis);

/* ---- adv/engine/labels.js ---- */
/* Readable names for ItemStatCost stats. u: unit shown after the value ('%', ' /s' ...). fp: value is 8.8 fixed point.
   Stats not listed fall back to PD2's own description string (patchstring) or the ItemStatCost name. */
(function (root) {
'use strict';
const L = {
  0: ['Strength'], 1: ['Energy'], 2: ['Dexterity'], 3: ['Vitality'], 4: ['Unspent stat points'], 5: ['Unspent skill points'],
  7: ['Life', '', 1], 9: ['Mana', '', 1], 11: ['Stamina', '', 1], 12: ['Level'], 14: ['Gold (inventory)'], 15: ['Gold (stash)'],
  16: ['Enhanced defense', '%'], 17: ['Enhanced maximum damage', '%'], 18: ['Enhanced minimum damage', '%'], 19: ['Attack rating'],
  20: ['Chance to block (item)', '%'], 21: ['Minimum damage'], 22: ['Maximum damage'], 23: ['Minimum damage (two-handed)'],
  24: ['Maximum damage (two-handed)'], 25: ['Damage', '%'], 26: ['Mana recovery (1/256 per frame)'], 27: ['Regenerate mana', '%'],
  28: ['Heal stamina', '%'], 31: ['Defense'], 32: ['Defense vs missiles'], 33: ['Defense vs melee'],
  34: ['Physical damage reduced by'], 35: ['Magic damage reduced by'], 36: ['Physical damage reduced by', '%'],
  37: ['Magic resist', '%'], 38: ['Maximum magic resist', '%'], 39: ['Fire resist', '%'], 40: ['Maximum fire resist', '%'],
  41: ['Lightning resist', '%'], 42: ['Maximum lightning resist', '%'], 43: ['Cold resist', '%'], 44: ['Maximum cold resist', '%'],
  45: ['Poison resist', '%'], 46: ['Maximum poison resist', '%'], 48: ['Minimum fire damage'], 49: ['Maximum fire damage'],
  50: ['Minimum lightning damage'], 51: ['Maximum lightning damage'], 52: ['Minimum magic damage'], 53: ['Maximum magic damage'],
  54: ['Minimum cold damage'], 55: ['Maximum cold damage'], 56: ['Cold length (frames)'], 57: ['Minimum poison damage (1/256 per frame)'],
  58: ['Maximum poison damage (1/256 per frame)'], 59: ['Poison length (frames)'], 60: ['Life stolen per hit', '%'],
  62: ['Mana stolen per hit', '%'], 64: ['Stamina drain'], 66: ['Stun length'], 67: ['Velocity', '%'], 68: ['Attack rate'],
  72: ['Durability'], 73: ['Maximum durability'], 74: ['Replenish life'], 75: ['Maximum durability', '%'],
  76: ['Maximum life', '%'], 77: ['Maximum mana', '%'], 78: ['Attacker takes damage of'], 79: ['Extra gold from monsters', '%'],
  80: ['Better chance of getting magic items', '%'], 81: ['Knockback'], 83: ['+ class skills'], 85: ['Experience gained', '%'],
  86: ['Life after each kill'], 87: ['Reduced vendor prices', '%'], 89: ['Light radius'], 91: ['Requirements', '%'],
  93: ['Increased attack speed', '%'], 96: ['Faster run/walk', '%'], 97: ['+ skill (any class)'], 99: ['Faster hit recovery', '%'],
  101: ['Poison length override (frames)'], 102: ['Faster block rate', '%'], 105: ['Faster cast rate', '%'], 107: ['+ single skill'],
  108: ['Slain monsters rest in peace'], 109: ['Curse resistance', '%'], 110: ['Poison length reduced by', '%'],
  111: ['Damage (flat, weapon)'], 112: ['Hit causes monster to flee'], 113: ['Hit blinds target'], 114: ['Damage taken goes to mana', '%'],
  115: ['Ignore target defense'], 116: ['Target defense', '%'], 117: ['Prevent monster heal'], 118: ['Half freeze duration'],
  119: ['Attack rating', '%'], 120: ['Monster defense per hit'], 121: ['Damage to demons', '%'], 122: ['Damage to undead', '%'],
  123: ['Attack rating against demons'], 124: ['Attack rating against undead'], 126: ['+ elemental skills'], 127: ['+ all skills'],
  128: ['Attacker takes lightning damage of'], 134: ['Freezes target'], 135: ['Open wounds', '%'], 136: ['Crushing blow', '%'],
  137: ['Kick damage'], 138: ['Mana after each kill'], 139: ['Life after each demon kill'], 141: ['Deadly strike', '%'],
  142: ['Fire absorb', '%'], 143: ['Fire absorb (flat)'], 144: ['Lightning absorb', '%'], 145: ['Lightning absorb (flat)'],
  146: ['Magic absorb', '%'], 147: ['Magic absorb (flat)'], 148: ['Cold absorb', '%'], 149: ['Cold absorb (flat)'],
  150: ['Slows target by', '%'], 151: ['Aura when equipped'], 152: ['Indestructible'], 153: ['Cannot be frozen'],
  154: ['Slower stamina drain', '%'], 155: ['Reanimate as'], 156: ['Piercing attack', '%'], 159: ['Minimum throw damage'],
  160: ['Maximum throw damage'], 164: ['Concentration'], 166: ['Pierce (skill)', '%'], 171: ['Defense (skills)', '%'],
  179: ['Attack vs monster type', '%'], 180: ['Damage vs monster type', '%'], 181: ['Fade'], 182: ['Defense override', '%'],
  188: ['+ skill tab'], 189: ['Open wounds stacks'], 190: ['Curse slots'], 191: ['Skill when equipped'], 194: ['Sockets'],
  195: ['Chance to cast on attack'], 196: ['Chance to cast on kill'], 197: ['Chance to cast on death'], 198: ['Chance to cast on striking'],
  199: ['Chance to cast on level-up'], 200: ['Chance to cast on cast'], 201: ['Chance to cast when struck'], 202: ['Chance to cast on block'],
  203: ['Chance to cast on critical hit'], 204: ['Charged skill'], 205: ['Chance to cast on pierce'], 206: ['Desecrated'],
  209: ['Joust reduction'], 210: ['Maximum deadly strike', '%'], 213: ['Minimum damage per energy'],
  256: ['Critical strike multiplier', '%'], 257: ['Deadly strike multiplier', '%'], 258: ['Critical strike chance', '%'],
  268: ['Crushing blow efficiency', '%'], 315: ['Fire length'], 316: ['Burning (min)'], 317: ['Burning (max)'], 326: ['Poison count'],
  329: ['Fire skill damage', '%'], 330: ['Lightning skill damage', '%'], 331: ['Cold skill damage', '%'], 332: ['Poison skill damage', '%'],
  333: ['Enemy fire resist', '-%'], 334: ['Enemy lightning resist', '-%'], 335: ['Enemy cold resist', '-%'], 336: ['Enemy poison resist', '-%'],
  337: ['Critical strike (skills)', '%'], 338: ['Dodge', '%'], 339: ['Avoid', '%'], 340: ['Evade', '%'], 341: ['Warmth', '%'],
  342: ['Mastery attack rating', '%'], 343: ['Mastery damage', '%'], 344: ['Mastery critical strike', '%'],
  345: ['Throw mastery attack rating', '%'], 346: ['Throw mastery damage', '%'], 347: ['Throw mastery critical strike', '%'],
  348: ['Weapon block', '%'], 349: ['Summon resist', '%'], 357: ['Magic skill damage', '%'], 358: ['Enemy magic resist', '-%'],
  359: ['Melee attacks deal splash damage'], 360: ['Corrupted'], 362: ['+ cold skills'], 363: ['+ fire skills'], 364: ['+ lightning skills'],
  365: ['+ poison skills'], 366: ['+ magic skills'], 367: ['Cold enchant'], 368: ['Maximum curses'], 424: ['Life after each hit'],
  425: ['Enemy physical resist', '-%'], 443: ['Extra bone spears'], 444: ['Extra revives'], 459: ['Extra spirits'],
  461: ['Extra skeleton warriors'], 462: ['Extra skeleton mages'], 463: ['Extra hydras'], 464: ['Extra valkyries'], 475: ['Extra skeleton archers'],
  476: ['Extra golems'], 478: ['Splash radius', '%'], 481: ['Extra holy bolts'], 484: ['Damage per ethereal item', '%'],
  487: ['Damage per missing life', '%'], 488: ['Life steal cap', '%'], 501: ['Open wounds damage per second'], 504: ['Curse effectiveness', '%'],
  507: ['Energy shield efficiency', '%'], 509: ['Extra grizzlies'],
};
function pretty(n) {
  return (n || '').replace(/^item_|^passive_|^skill_/, '').replace(/_/g, ' ').replace(/percent/g, '%').replace(/\s+/g, ' ').trim()
    .replace(/^./, c => c.toUpperCase());
}
function label(D, id, P) {
  const l = L[id]; if (l) return l[0];
  const s = D && D.isc[id];
  if (s && P && s.dsp && P[s.dsp]) return P[s.dsp].replace(/%\+?d%%|%\+?d|%s|%%/g, '').replace(/\s+/g, ' ').replace(/^[\s+:-]+|[\s+:-]+$/g, '').trim() || pretty(s.n);
  return pretty(s ? s.n : 'stat ' + id);
}
const unit = id => (L[id] && L[id][1]) || '';
const fixed = id => !!(L[id] && L[id][2]);
const API = { L, label, unit, fixed, pretty };
if (typeof module !== 'undefined' && module.exports) module.exports = API; else root.PD2Labels = API;
})(typeof window !== 'undefined' ? window : globalThis);

/* ---- adv/engine/speed.js ---- */
/* Frame counts and breakpoints for Project Diablo 2: attack (IAS), cast (FCR), hit recovery (FHR), block (FBR).
   Same rules as the Attack Speed calculator (verified natively, see FINDINGS.md "Attack speed"):
     D2Common 0x6FD83110 (animation rate), EIAS table 0x6FDE4608 (E = tdiv(k*v, k+v), k = 120 for IAS/FCR/FHR/FBR)
     cast   (player mode SC, or SQ when the skill's seqtrans is SC, 0x6FD80B80): s = min(100 + EFCR, 175)
     hit    (GH, 0x6FD7EFC0): s = 50 + EFHR                (no cap)
     block  (BL, 0x6FD7EF90): s = 50 (100 with Holy Shield) + EFBR  (no cap)
     attack: s = attackrate (stat 68) + EIAS, -30 in SQ, clamped 15..175; wereform override 0x6FD83C20.
     rate = min(floor(animSpeed * s / 100), 0x7FFF); frames = ceil((len - start*256) / rate) - 1.
   DATA = the Attack Speed calculator's data: {anim, start, wcRow, seq, multi, skills}. */
(function (root) {
'use strict';
const tdiv = (a, b) => (b ? Math.trunc(a / b) : 0);
const eff = v => (v === 0 ? 0 : (v === -120 ? NaN : tdiv(120 * v, 120 + v)));
const TOK = ['AM', 'SO', 'NE', 'PA', 'BA', 'DZ', 'AI'];

/* weapon record for animation purposes: {w: WSM, wc, wc2, two, b12} from engine D.items */
function wrec(D, it) {
  if (!it) return null; const b = D.items[it.code]; if (!b || b.c !== 'weapon') return null;
  return { w: b.sp, wc: b.wc || 'hth', wc2: b.wc2 || b.wc || 'hth', two: b.h2 ? 1 : 0, b12: b.h12 ? 1 : 0, code: it.code, name: it.name };
}
/* weapon class of the animation (D2Common 0x6FD93860 / 0x6FD6FB80, verified) */
function animClass(S, cls, w1, w2, dual, shield, primaryIs1) {
  if (!w1 && !w2) return 'hth';
  if (dual && w1 && w2) {
    if (cls === 6) return 'ht2';
    if (cls === 4) {
      const p = primaryIs1 ? w1 : w2, o = primaryIs1 ? w2 : w1;
      const a = S.wcRow[p.wc] || 0, b = S.wcRow[o.wc] || 0;
      if (a === 2) return b === 3 ? '1js' : '1ss';
      if (a === 3) return b === 3 ? '1jt' : (b === 2 ? '1st' : '1ss');
      return '1ss';
    }
  }
  const w = w1 || w2;
  if (w.two && !(cls === 4 && w.b12 && shield)) return w.wc2;
  return w.wc;
}
function anim(S, key) { const r = S.anim[key]; return r ? { frames: r[0], speed: r[1], event: r[2], key } : null; }
const framesAt = (len, start, speed, s) => {
  const rate = Math.min(Math.floor(speed * s / 100), 0x7fff);
  return rate > 0 ? Math.ceil((len - start * 256) / rate) - 1 : Infinity;
};

/* ---- cast / hit recovery / block ---- */
function modeSpec(kind, opts) {
  if (kind === 'fcr') return { base: 100, cap: 175 };
  if (kind === 'fhr') return { base: 50, cap: Infinity };
  return { base: opts && opts.holyShield ? 100 : 50, cap: Infinity };      // fbr
}
function modeFrames(kind, a, value, opts) {
  const m = modeSpec(kind, opts); const e = eff(value);
  const s = Math.min(m.base + e, m.cap);
  return framesAt(a.frames * 256, 0, a.speed, s);
}
/* breakpoint list: [{at, frames}] for stat values 0..max where the frame count drops */
function modeBreakpoints(kind, a, opts, max) {
  const out = []; let last = null;
  for (let v = 0; v <= (max || 400); v++) {
    const f = modeFrames(kind, a, v, opts);
    if (last === null || f < last) { out.push({ at: v, frames: f }); last = f; }
  }
  return out;
}
/* the animation used for cast / GH / BL. form: '' | '40' (wolf) | 'TG' (bear). seq: sequence frames for SQ casts. */
function modeAnim(S, cls, form, mode, wc, seqFrames) {
  if (seqFrames) return { frames: seqFrames, speed: 256, event: -1, key: 'SQ' };   // SQ uses AnimData's default record (speed 256)
  if (form) return anim(S, form + mode + 'HTH');
  return anim(S, TOK[cls] + mode + wc.toUpperCase()) || anim(S, TOK[cls] + mode + 'HTH');
}

/* ---- attacks (port of the calculator's framesFor) ----
   p = {cls, form ('' | '40' | 'TG'), skill (DATA.skills entry or null), w1, w2 (wrec), dual, shield,
        w1ias, w2ias (each weapon's own IAS), gias (all other IAS incl. skills), sias (skill speed: stat 68 - 100 + WSM),
        mLvl, mTgt (follow-up skills)} */
function multiHits(m, lvl, tgt) {
  const h = m.h; lvl = Math.max(1, lvl | 0); tgt = Math.max(0, tgt | 0);
  if (h.t === 'fixed') return h.n;
  if (h.t === 'minlvl') return Math.min(h.a + lvl - 1, h.b);
  if (h.t === 'dt') return Math.min(tdiv(lvl, 6) + 1, 3);
  if (h.t === 'strafe') { const mx = Math.min(h.a + lvl - 1, h.b), mn = Math.min(2 + tdiv(lvl, 4), mx); return Math.min(Math.max(tgt, mn), mx); }
  return 1;
}
function cliEventStep(P, r, len, A) {
  let pos = P;
  for (let k = 1; pos < len; k++) {
    const j0 = (pos >> 8) + (r >= 256 ? 1 : 0); pos += r;
    if (pos < len) { if (j0 <= A && A <= (pos >> 8)) return k; }
    else { if (j0 <= A && A < (len >> 8)) return k; return -1; }
  }
  return -1;
}
function clientCycle(P0, r, len, A, h, p) {
  const sw = []; let P = P0;
  for (let i = 0; i < h; i++) {
    const n = Math.ceil((len - P) / r) - 1;
    const k = cliEventStep(P, r, len, A);
    if (k < 0 || k > n) { sw.push({ len: n, hit: null }); break; }
    if (i < h - 1) { const fi = (P + k * r) >> 8; sw.push({ len: k, hit: k }); P = tdiv(fi * (100 - p), 100) * 256; }
    else sw.push({ len: n, hit: k });
  }
  return sw;
}
function srvStep(P, jStart, r, len, A) {
  let pos = P + r, j = jStart;
  for (let k = 1; pos < len; k++, pos += r) { const fi = pos >> 8; if (j <= A && A <= fi) return k; if (j <= fi) j = fi + 1; }
  return -1;
}
function serverHits(st, r, len, A, h, p) {
  const t = []; let k = srvStep(st * 256, st, r, len, A); if (k < 0) return t;
  let now = k, origin = 0; t.push(now);
  for (let i = 1; i < h; i++) {
    const k0 = tdiv((now - origin) * (100 - p), 100); origin = now - k0;
    k = srvStep(k0 * 256, k0 - 1, r, len, A); if (k < 0) break;
    now += k; t.push(now);
  }
  return t;
}

function attackSetup(S, p) {
  const { cls, w1, w2 } = p; const dualOn = !!(p.dual && w1 && w2 && (cls === 4 || cls === 6));
  let wsm = w1 ? w1.w : 0, weapIas = w1 ? p.w1ias : 0, fast = 1;
  if (dualOn) {
    const a = -w1.w + p.w1ias, b = -w2.w + p.w2ias;
    if (a > b) { wsm = w1.w; weapIas = p.w1ias; fast = 1; } else { wsm = w2.w; weapIas = p.w2ias; fast = 2; }
  } else if (!w1 && w2) { wsm = w2.w; weapIas = p.w2ias; }
  const cw = dualOn ? (fast === 1 ? w1 : w2) : (w1 || w2);
  return { dualOn, wsm, weapIas, fast, cw };
}

function attackFrames(S, p, mode, giasVal, wIasOverride) {
  const { cls, form, skill, w1, w2, shield } = p;
  const A0 = attackSetup(S, p); const dualOn = A0.dualOn, wsm = A0.wsm, cw = A0.cw;
  const wIasVal = wIasOverride !== undefined ? wIasOverride : A0.weapIas;
  const multi = skill && S.multi && S.multi[skill.n] ? S.multi[skill.n] : null;
  const nHits = multi ? multiHits(multi, p.mLvl || 1, p.mTgt || 1) : 0;
  const totIas = giasVal + wIasVal;
  const e = eff(totIas);
  let base, len, start = 0, key, seqPenalty = 0, clientBase = null;
  if (mode === 'SQ') {
    const wc = animClass(S, cls, w1, w2, dualOn, shield, true);
    const n = (S.seq[skill.sq] || {})[wc] || 0;
    if (!n) return { err: 'This skill has no sequence for the ' + wc + ' weapon class.' };
    len = n * 256; base = 256; seqPenalty = 30; key = 'SQ' + skill.sq + ' ' + wc;
  } else if (form) {
    if (mode !== 'A1' && mode !== 'A2') return { err: 'In werewolf or werebear form only A1/A2 attacks are covered.' };
    key = form + mode + 'HTH'; const rec = S.anim[key];
    if (!rec) return { err: 'No animation ' + key };
    len = rec[0] * 256;
    const w = w1 || w2; let div;
    if (!w) div = 19;
    else {
      const hk = TOK[cls] + 'A1' + animClass(S, cls, w1, w2, dualOn, shield, true).toUpperCase(); const h = S.anim[hk];
      if (!h) div = 45;
      else {
        const wiasHere = w === cw ? wIasVal : (w === w1 ? p.w1ias : p.w2ias);
        const d = tdiv((100 - w.w + wiasHere) * h[1], 100);
        if (d === 0) return { err: 'This weapon speed divides by zero in the game code.' };
        div = tdiv(h[0] * 256, d);
      }
    }
    const q = div > 0 ? tdiv(len & ~0xff, div) : 0;
    base = q > 0 ? q : rec[1];
    const nu = S.anim[form + 'NUHTH'];
    const qc = (div > 0 && nu) ? tdiv((nu[0] * 256) & ~0xff, div) : 0;
    clientBase = qc > 0 ? qc : rec[1];
  } else {
    const wc = animClass(S, cls, w1, w2, dualOn, shield, true);
    key = TOK[cls] + mode + wc.toUpperCase(); const rec = S.anim[key];
    if (!rec) return { err: 'No ' + mode + ' animation for this class with this weapon (' + key + ').' };
    len = rec[0] * 256; base = rec[1];
    if (mode === 'A1' || mode === 'A2') { const pw = w1 || w2; const row = pw ? (S.wcRow[pw.wc] || 0) : 0; start = S.start[row][cls]; }
  }
  if (Number.isNaN(e)) return { err: 'Total IAS of exactly -120 divides by zero in the game code.' };
  // skill start functions that attach a temporary attackrate while the animation plays (adv/re/skill_speed.md):
  // Dragon Tail (srvstfunc 27 + cltstfunc 9: Param4), Double Swing (client cltstfunc 27: cltcalc1 = par5)
  const skSpeed = p.skillAttackRate || 0;
  const sp = 100 + (p.sias || 0) + skSpeed - wsm + e - seqPenalty;
  const spc = Math.max(15, Math.min(175, sp));
  const rate = Math.min(Math.floor(base * spc / 100), 0x7fff);
  if (rate <= 0) return { err: 'The attack never finishes at this speed.' };
  const fpa = Math.ceil((len - start * 256) / rate) - 1;
  let cfpa = null, crate = null;
  if (clientBase !== null) { crate = Math.min(Math.floor(clientBase * spc / 100), 0x7fff); cfpa = crate > 0 ? Math.ceil(len / crate) - 1 : null; }
  let held = cfpa !== null ? cfpa : fpa;
  let mh = null;
  if (multi && mode !== 'SQ') {
    const A = (S.anim[key] || [])[2];
    if (A === undefined || A < 0) return { err: 'This animation has no hit frame.' };
    const rc = crate !== null ? crate : rate;
    const sw = clientCycle(start * 256, rc, len, A, nHits, multi.p);
    const cyc = sw.reduce((a, x) => a + x.len, 0);
    const sHits = serverHits(start, rate, len, A, nHits, multi.p);
    const kept = sHits.filter(x => x < cyc);
    mh = { sw, cyc, sHits, kept, A, n: nHits };
    held = cyc;
  }
  return { fpa, held, rate, e, sp, spc, base, len, start, key, totIas, cfpa, mh, wsm, dual: dualOn };
}
function attackBreakpoints(S, p, mode, wIas) {
  const out = []; let last = null;
  const A0 = attackSetup(S, p); const w = wIas !== undefined ? wIas : A0.weapIas;
  for (let g = 0; g <= 600; g++) {
    if (g + w === -120) continue;
    const r = attackFrames(S, p, mode, g, w); if (r.err) continue;
    const pat = r.mh ? r.mh.sw.map(x => x.len).join('/') + '|' + r.mh.kept.length : null;
    if (last === null || r.held < last.held || (pat && pat !== last.pat)) { out.push({ at: g, frames: r.held, pattern: r.mh ? r.mh.sw.map(x => x.len).join('/') : null, spc: r.spc }); last = { held: r.held, pat }; }
  }
  return out;
}

/* the temporary attack-rate term for a skill (Skills.txt params from engine data) */
function skillAttackRate(D, id) {
  const sk = D && D.skills[id]; if (!sk) return 0;
  if (id === 270) return sk.p[3] || 0;      // Dragon Tail: Param4 (PD2 -20), server and client
  if (id === 133) return sk.p[4] || 0;      // Double Swing: cltcalc1 = par5 (PD2 +50), client only; the client paces held attacks
  return 0;
}
const API = { skillAttackRate, eff, TOK, wrec, animClass, anim, modeFrames, modeBreakpoints, modeAnim, attackFrames, attackBreakpoints, attackSetup, multiHits };
if (typeof module !== 'undefined' && module.exports) module.exports = API; else root.PD2Speed = API;
})(typeof window !== 'undefined' ? window : globalThis);

/* ---- adv/engine/derive.js ---- */
/* Everything the Advanced Stats page shows, derived from engine.js compute() with the reverse-engineered formulas in
   adv/re/*.js (character screen, block/regen, MF/speed, auras) and speed.js (breakpoints). */
(function (root) {
'use strict';
const req = (n, g) => (typeof require === 'function' && typeof module !== 'undefined') ? require(n) : root[g];
const E = req('./engine.js', 'PD2Adv');
const CS = req('../re/charscreen.js', 'PD2CharScreen');
const BR = req('../re/block_regen.js', 'PD2BlockRegen');
const MM = req('../re/mf_misc.js', 'PD2MfMisc');
const SP = req('./speed.js', 'PD2Speed');
const tdiv = (a, b) => (b ? Math.trunc(a / b) : 0);

const CLASS = ['Amazon', 'Sorceress', 'Necromancer', 'Paladin', 'Barbarian', 'Druid', 'Assassin'];
const DIFF = ['Normal', 'Nightmare', 'Hell'];
// skill tab names by SkillDesc SkillPage (1..3)
const TABS = [['Bow and Crossbow', 'Passive and Magic', 'Javelin and Spear'], ['Fire', 'Lightning', 'Cold'], ['Curses', 'Poison and Bone', 'Summoning'],
  ['Combat Skills', 'Offensive Auras', 'Defensive Auras'], ['Combat Skills', 'Masteries', 'Warcries'], ['Summoning', 'Shape Shifting', 'Elemental'],
  ['Traps', 'Shadow Disciplines', 'Martial Arts']];
function tabNames(D, cls) { const o = {}; (TABS[cls] || []).forEach((n, i) => { o[i + 1] = n; }); return o; }

function sumMastery(C, stat) {                     // PD 0x102728B0: mastery entries whose item type matches the weapon
  let v = 0; for (const r of C.skillRows) if (r.weaponMatch && r.itype) for (const [s, x] of r.rows) if (s === stat) v += x; return v;
}
function isShield(D, it) { const b = it && D.items[it.code]; return !!b && E.isType(D, b.t, 'shie'); }

function weaponInfo(C) {
  const D = C.D; const W = C.weapons;
  const w1 = SP.wrec(D, W.right), w2 = SP.wrec(D, W.left);
  const own = (it, id) => { const l = C.itemLists.find(x => x.it === it); return l ? l.T.sum(id) : 0; };
  const w1ias = W.right && w1 ? own(W.right, 93) : 0, w2ias = W.left && w2 ? own(W.left, 93) : 0;
  const shield = isShield(D, W.left) || isShield(D, W.right);
  const first = w1 || w2;
  const dual = !!(w1 && w2);
  let wsmSum = (w1 ? w1.w : 0) + (w2 ? w2.w : 0);
  return { w1, w2, w1ias, w2ias, shield, first, dual, wsmSum, raw: W };
}

/* monster targets for the hit-chance table */
const TARGETS = [
  { n: 'Act 1 Normal (lvl 5, def 10)', lvl: 5, def: 10 },
  { n: 'Nightmare mid (lvl 50, def 400)', lvl: 50, def: 400 },
  { n: 'Hell mid (lvl 80, def 1000)', lvl: 80, def: 1000 },
  { n: 'Hell high (lvl 85, def 1500)', lvl: 85, def: 1500 },
  { n: 'Map tier 3 (lvl 90, def 2000)', lvl: 90, def: 2000 },
  { n: 'Uber (lvl 99, def 3000)', lvl: 99, def: 3000 },
];

function derive(model, D, S, opts) {
  opts = opts || {};
  const form = opts.form || '';
  const C = E.compute(model, D, { swap: !!opts.swap, buffs: opts.buffs || [], partyAuras: opts.partyAuras || [] });
  const T = C.T; const cls = model.cls; const clvl = model.level;
  const diff = opts.difficulty === undefined ? 2 : opts.difficulty;
  const P = E.panel(C, { difficulty: diff });
  const X = E.extras(C);
  const out = { C, P, X, cls, className: CLASS[cls], clvl, diff, diffName: DIFF[diff], form };
  const has = id => C.auraRows.some(a => a.id === id);

  // ---- character screen: AR, defense, damage (D2Client 0x6FADC4F0 / #10672 / 0x6FAE1220)
  const mastery = { ar: sumMastery(C, 342), dmg: sumMastery(C, 343) };
  const ctx = CS.fromEngine(C, { mastery, skill: { srcDam: 128 } });
  out.cs = { ctx, mastery, ar: CS.attackRating(ctx), defense: CS.defense(ctx), damage: CS.weaponDamage(ctx), baseAR: CS.baseAR(ctx.T, C.cls) };
  out.cs.arPct = mastery.ar + ctx.T(119);
  out.hit = TARGETS.map(t => ({ ...t, chance: CS.hitChance(out.cs.ar, clvl, t.def, t.lvl) }));
  if (opts.monster) out.hitCustom = { ...opts.monster, chance: CS.hitChance(out.cs.ar, clvl, opts.monster.def, opts.monster.lvl) };
  out.enemyHitsYou = [60, 75, 85, 90].map(ml => ({ mlvl: ml, arFor50: null }));

  // ---- block (D2Common #10212; PD2 roll 0x1026FB60)
  const WI = weaponInfo(C);
  const bctx = { T, cls: C.cls, hasShield: WI.shield, states: has(117) ? ['holyshield'] : [] };
  out.block = { chance: BR.blockChance(bctx), shield: WI.shield, factor: C.cls.BlockFactor, toblock: T(20) };
  const wc = SP.animClass(S, cls, WI.w1, WI.w2, WI.dual, WI.shield, true);
  out.block.weapon = WI.shield ? 0 : BR.weaponBlockChance({ T, wclass: wc === '2hs' ? 5 : (wc === 'ht2' ? 13 : 0) });

  // ---- regeneration (D2Game 0x6FC97CB0 / 0x6FC97950 / 0x6FC97A50)
  const rctx = { T, cls: C.cls };
  out.regen = {
    life: BR.lifeRegen(rctx), mana: BR.manaRegen(rctx), manaFull: T(9) > 0 ? (T(9) / 256) / BR.manaRegen(rctx) : null,
    stamStand: BR.staminaRegen(rctx, 1), stamWalk: BR.staminaRegen(rctx, 2), stamDrain: BR.staminaDrain(rctx),
  };

  // ---- loot and movement
  out.mf = MM.effectiveMF(T(80));
  out.run = MM.runSpeed({ frw: T(96), running: true, velocityPercent: T(67), walkVelocity: C.cls.WalkVelocity || 6, runVelocity: C.cls.RunVelocity || 9 });
  out.walk = MM.runSpeed({ frw: T(96), running: false, velocityPercent: T(67), walkVelocity: C.cls.WalkVelocity || 6, runVelocity: C.cls.RunVelocity || 9 });
  out.baseRun = MM.runSpeed({ frw: 0, running: true, velocityPercent: 0, walkVelocity: C.cls.WalkVelocity || 6, runVelocity: C.cls.RunVelocity || 9 });

  // ---- breakpoints: cast (SC), hit recovery (GH), block (BL)
  const castAnim = SP.modeAnim(S, cls, form, 'SC', wc);
  const ghAnim = SP.modeAnim(S, cls, form, 'GH', wc);
  const blAnim = SP.modeAnim(S, cls, form, 'BL', wc);
  const bp = (kind, a, v, o) => a ? { anim: a, frames: SP.modeFrames(kind, a, v, o), list: SP.modeBreakpoints(kind, a, o, 400), value: v } : null;
  out.fcr = bp('fcr', castAnim, T(105));
  out.fhr = bp('fhr', ghAnim, T(99));
  out.fbr = bp('fbr', blAnim, T(102), { holyShield: has(117) });
  // sequence casts that use cast speed (SQ mode with seqtrans SC, 0x6FD80B80): e.g. Chain Lightning, Frozen Orb (seq 12)
  out.fcrSeq = [];
  for (const s of S.skills) if (s.a === 'SQ' && s.cl === cls && D.skills[s.id] && C.levels(s.id).lvl > 0) {
    const sk = D.skills[s.id];
    if (!/^(Chain Lightning|Frozen Orb)$/.test(sk.n)) continue;
    const n = (S.seq[s.sq] || {})[wc] || 0; if (!n) continue;
    const a = SP.modeAnim(S, cls, '', 'SC', wc, n);
    out.fcrSeq.push({ name: sk.dn || sk.n, ...bp('fcr', a, T(105)) });
  }

  // ---- attack speed (IAS)
  const sias = T(68) - 100 + WI.wsmSum;
  const gias = T(93) - WI.w1ias - WI.w2ias;
  const sp = { cls, form, skill: null, w1: WI.w1, w2: WI.w2, dual: WI.dual, shield: WI.shield, w1ias: WI.w1ias, w2ias: WI.w2ias, gias, sias,
    mLvl: 1, mTgt: 1 };
  let skill = null;
  if (opts.speedSkill) { skill = S.skills.find(x => x.id === opts.speedSkill) || null; if (skill) { sp.skill = skill; sp.skillAttackRate = SP.skillAttackRate(D, skill.id); const L = C.levels(skill.id); sp.mLvl = Math.max(1, L.lvl); sp.mTgt = opts.targets || 1; } }
  const modes = skill ? [skill.a] : ['A1', 'A2'];
  out.ias = { sias, gias, w1ias: WI.w1ias, w2ias: WI.w2ias, total: T(93), skill: skill ? (skill.dn || skill.n) : null, weaponClass: wc,
    modes: modes.map(m => ({ mode: m, r: SP.attackFrames(S, sp, m, gias) })) };
  const A0 = SP.attackSetup(S, sp);
  out.ias.counted = gias + A0.weapIas;                   // IAS the game counts (PD2 dual wield: only the faster weapon's own IAS)
  out.ias.offset = form ? 0 : A0.weapIas;                // breakpoints shown as total IAS unless the wereform override is in play
  const main = out.ias.modes.find(x => !x.r.err);
  if (main) out.ias.list = SP.attackBreakpoints(S, sp, main.mode);
  out.ias.speedSkills = S.skills.filter(s => (s.cl === cls || C.levels(s.id).lvl > 0) && C.levels(s.id).lvl > 0);

  // ---- resistances
  const pen = [0, -40, -100][diff];
  out.res = [['Fire', 39, 40, 'fire'], ['Cold', 43, 44, 'cold'], ['Lightning', 41, 42, 'light'], ['Poison', 45, 46, 'poison']].map(([n, s, m, k]) => {
    const raw = T(s), max = Math.min(T(m) + 75, 90), cur = raw + pen;
    return { n, k, raw, cur, max, eff: Math.min(cur, max), over: cur - max, bonusMax: T(m) };
  });
  out.res.push({ n: 'Magic', k: 'magic', raw: T(37), cur: T(37), max: Math.min(T(38) + 75, 90), eff: Math.min(T(37), Math.min(T(38) + 75, 90)), over: T(37) - Math.min(T(38) + 75, 90), bonusMax: T(38) });

  // ---- skills
  const tabs = tabNames(D, cls);
  out.skills = [];
  for (const [idStr, sk] of Object.entries(D.skills)) {
    const id = +idStr; if (sk.cl !== cls || !sk.tab) continue;
    const L = C.levels(id); const hard = model.skills[id] || 0;
    out.skills.push({ id, n: sk.dn || sk.n, tab: sk.tab, tabName: tabs[sk.tab] || ('Tab ' + sk.tab), row: sk.row, col: sk.col, hard, lvl: L.lvl, bonus: L.lvl - hard, reqlvl: sk.rl });
  }
  out.skills.sort((a, b) => a.tab - b.tab || a.row - b.row || a.col - b.col);
  // oskills, charges, procs, auras from items
  out.itemSkills = [];
  C.R.each((id, p, v) => {
    if (!v) return;
    const nm = x => (D.skills[x] ? (D.skills[x].dn || D.skills[x].n) : 'skill ' + x);
    if (id === 97) out.itemSkills.push({ kind: 'oskill', n: nm(p), lvl: C.levels(p).lvl, add: v, id: p });
    else if (id === 204) out.itemSkills.push({ kind: 'charges', n: nm(p >> 6), lvl: p & 63, cur: v & 255, max: v >> 8, id: p >> 6 });
    else if (id >= 195 && id <= 205 && id !== 204) out.itemSkills.push({ kind: { 195: 'on attack', 196: 'on kill', 197: 'on death', 198: 'on striking', 199: 'on level-up', 200: 'on cast', 201: 'when struck', 202: 'on block', 203: 'on critical', 205: 'on pierce', 359: 'splash' }[id], n: nm(p >> 6), lvl: p & 63, chance: v, id: p >> 6 });
    else if (id === 151) out.itemSkills.push({ kind: 'aura', n: nm(p), lvl: v, id: p });
    else if (id === 191) out.itemSkills.push({ kind: 'when equipped', n: nm(p), lvl: v, id: p });
  });

  // ---- buff candidates the character can use (class skills with points, oskills), by owner rule (adv/re/auras.md)
  const AU = req('../re/auras.js', 'PD2Auras');
  out.buffCandidates = [];
  for (const [idStr, sk] of Object.entries(D.skills)) {
    const id = +idStr; const L = C.levels(id); if (!L.lvl) continue;
    const kinds = AU.selfBuffStats(Object.assign({ id }, sk), L.lvl, L.blvl, { id }).map(x => x.which);
    const ownStats = (kinds.includes('aura') ? sk.as.length : 0) + (kinds.includes('passive') && !sk.pst ? sk.ps.length : 0);
    if (!ownStats && !sk.aura) continue;
    if (sk.passive) continue;
    const doF = sk.do || AU.DOFUNC[id];
    if (![65, 66, 81, 18, 23, 47, 68, 25, 116, 120, 9].includes(doF)) continue;
    out.buffCandidates.push({ id, n: sk.dn || sk.n, lvl: L.lvl, aura: !!sk.aura, form: doF === 116 ? (/bear/i.test(sk.n) ? 'TG' : '40') : '', on: (opts.buffs || []).some(b => b.id === id) });
  }
  out.partyAuraChoices = Object.entries(D.skills).filter(([id, sk]) => sk.aura && sk.cl >= 0 && sk.cl <= 6 && [65].includes(sk.do)).map(([id, sk]) => ({ id: +id, n: sk.dn || sk.n }));

  // ---- every stat total
  out.allStats = [];
  const seen = new Set(); C.R.each((id) => seen.add(id));
  for (const id of [...seen].sort((a, b) => a - b)) { const v = T(id); if (!v && !C.R.sum(id)) continue; out.allStats.push({ id, v, raw: C.R.sum(id), src: C.src.get(id) || [] }); }
  return out;
}

const API = { TABS, derive, CLASS, DIFF, TARGETS, weaponInfo, sumMastery };
if (typeof module !== 'undefined' && module.exports) module.exports = API; else root.PD2Derive = API;
})(typeof window !== 'undefined' ? window : globalThis);

/* ---- adv/engine/combat.js ---- */
/* Combat numbers for the Advanced Stats page, built on the reverse-engineered modules in adv/re:
   damage.js (player -> monster), defense.js (monster -> player, monster stats), skilldmg.js (skill damage),
   minions.js (summons and mercenaries). Everything here only wires those formulas to the character. */
(function (root) {
'use strict';
const req = (n, g) => (typeof require === 'function' && typeof module !== 'undefined') ? require(n) : root[g];
const DMG = req('../re/damage.js', 'PD2Damage');
const DEF = req('../re/defense.js', 'PD2Defense');
const SKD = req('../re/skilldmg.js', 'PD2SkillDmg');
const MIN = req('../re/minions.js', 'PD2Minions');
const CS = req('../re/charscreen.js', 'PD2CharScreen');
const E = req('./engine.js', 'PD2Adv');

const ELEM = [
  { k: 'phys', n: 'Physical', res: 'phys', pierce: 425, mast: null },
  { k: 'fire', n: 'Fire', res: 'fire', pierce: 333, mast: 329, lo: 48, hi: 49 },
  { k: 'cold', n: 'Cold', res: 'cold', pierce: 335, mast: 331, lo: 54, hi: 55 },
  { k: 'light', n: 'Lightning', res: 'light', pierce: 334, mast: 330, lo: 50, hi: 51 },
  { k: 'poison', n: 'Poison', res: 'poison', pierce: 336, mast: 332 },
  { k: 'magic', n: 'Magic', res: 'magic', pierce: 358, mast: 357, lo: 52, hi: 53 },
];

/* ---- debuffs on the monster: auras/curses that lower its resistances (their aurastats evaluated at the level) ----
   list = [{id: skill id, lvl, curseMastery}], e.g. Infinity = Conviction (123) level 12 (Runes.txt aura Conviction 12).
   On a monster whose BASE resist is 100 or more each negative contribution counts half (PD2 0x102C0540). */
const RES_STAT = { 36: 'phys', 37: 'magic', 39: 'fire', 41: 'light', 43: 'cold', 45: 'poison' };
function debuffValues(D, list) {
  const out = { phys: [], magic: [], fire: [], light: [], cold: [], poison: [] };
  for (const d of list || []) {
    const sk = D.skills[d.id]; if (!sk || !d.lvl) continue;
    const ctx = { D, sk, lvl: d.lvl, blvl: 0, clvl: 90, levels: id => (D.skills[id] && /CurMas|Curse Mastery/i.test(D.skills[id].n) ? { lvl: d.curseMastery || 0, blvl: d.curseMastery || 0 } : { lvl: 0, blvl: 0 }), stat: () => 0 };
    for (const [st, calc] of sk.as) { const k = RES_STAT[st]; if (!k) continue; const v = E.evalCalc(calc, ctx); if (v) out[k].push(v); }
  }
  return out;
}
function applyDebuffs(res, deb) {
  const r = {};
  for (const k of Object.keys(res)) r[k] = DMG.monsterResAfterCurses(res[k] | 0, (deb && deb[k]) || []);
  return r;
}

/* ---- target monster (defense.js monsterAt) ---- */
function target(opts) {
  const o = opts || {};
  const m = DEF.monsterAt(o.id || 'doomknight1', o.difficulty === undefined ? 2 : o.difficulty, o.areaLevel || 85, o.kind || 'normal', { players: o.players || 1 });
  const ms = (root.MONSTER_DATA || {}).monstats ? root.MONSTER_DATA.monstats[m.id] : null;
  m.drain = ms && ms.Drain ? ms.Drain[o.difficulty === undefined ? 2 : o.difficulty] : 0;
  m.primeEvil = !!(ms && ms.primeevil);
  m.name = (ms && ms.name) || m.id;
  m.lifeAvg = Math.round((m.life.min + m.life.max) / 2);
  if (o.resOverride) for (const k of Object.keys(o.resOverride)) if (o.resOverride[k] !== null && o.resOverride[k] !== undefined && o.resOverride[k] !== '') m.res[k] = +o.resOverride[k];
  m.resBase = Object.assign({}, m.res);
  if (o.debuffs && o.debuffs.length && o.D) { m.deb = debuffValues(o.D, o.debuffs); m.res = applyDebuffs(m.resBase, m.deb); }
  return m;
}

/* ---- 1. effective life for each damage type (defense.js) ---- */
function effectiveLife(R, diff) {
  const T = R.C.T, life = Math.floor(T(7) / 256);
  const eff = DEF.effectiveLife(life, { S: T, difficulty: diff });
  return { life, eff };
}

/* ---- 4. monsters hitting you: typical monsters at an area level ---- */
function monstersOnYou(R, diff, areaLevel) {
  const T = R.C.T, life = Math.floor(T(7) / 256);
  const set = DEF.HELL_SET;
  const block = R.block.chance > 0 ? R.block.chance : (R.block.weapon || 0);
  const rows = [];
  const pdef = DEF.playerDefense(T, false);
  for (const id of set) {
    for (const kind of ['normal', 'champion', 'unique']) {
      let m; try { m = DEF.monsterAt(id, diff, areaLevel, kind, {}); } catch (e) { continue; }
      const hit = DEF.hitChance(m.ar, m.lvl, pdef, R.clvl);
      const o = { S: T, difficulty: diff };
      const avg8 = Math.round((m.dmgMin + m.dmgMax) / 2 * 256);
      const after = DEF.applyType8(0, avg8, o).dmg8 / 256;
      const landed = hit * (100 - Math.max(0, block)) / 100;
      const ms = root.MONSTER_DATA && root.MONSTER_DATA.monstats[id];
      rows.push({ id, name: (ms && ms.name) || id, kind, lvl: m.lvl, ar: m.ar, hit, landed, dmgMin: m.dmgMin, dmgMax: m.dmgMax, after,
        hitsToKill: after > 0 ? Math.ceil((life - 255 / 256) / after) : Infinity, elem: m.elem });
    }
  }
  return { rows, playerDefense: pdef, block, life };
}

/* ---- 2/3/5. normal-attack damage per hit and per second against a target (damage.js) ---- */
function attackOn(R, tgt, diff) {
  const C = R.C, T = C.T, ct = R.cs.ctx, P = R.P;
  const W = C.weapons.weapons[0] || null, D = C.D;
  const b = W ? D.items[W.code] : null;
  const p = { weapon: !!W, twoHandGrip: ct.weapon && ct.weapon['2handed'], s21: T(21), s22: T(22), s23: T(23), s24: T(24),
    s111: T(111), s17: ct.T(17), s18: ct.T(18), s25: T(25), str: T(0), dex: T(2), strBonus: b ? b.sb : 0, dexBonus: b ? b.db : 0,
    mastery: R.cs.mastery.dmg, enDmgPct: 0, src: 128 };
  if (T(121) && tgt.demon) p.enDmgPct += T(121);
  const range = DMG.physRange(p);
  const physAvg = (range.minPts + range.maxPts) / 2;
  const critO = { critChance: P.crit.chance, ds: T(141), dsMaxBonus: T(210), critMult: T(256), dsMult: T(257) };
  const critMul = DMG.critMultiplier(critO);
  const physRes = tgt.res.phys | 0, physPierce = T(425);
  const physFactor = DMG.damageFactor(physRes, physPierce);
  const physHit = physAvg * critMul * physFactor;
  const elem = [];
  for (const e of ELEM) {
    if (!e.lo) continue;
    let lo = T(e.lo), hi = T(e.hi); if (!lo && !hi) continue;
    const m = e.mast ? T(e.mast) : 0; lo += Math.trunc(lo * m / 100); hi += Math.trunc(hi * m / 100);
    const avg = (lo + hi) / 2, res = tgt.res[e.res] | 0, pierce = T(e.pierce);
    const after = DMG.elemAfterRes(avg, res, pierce, { playerOwned: true });
    elem.push({ k: e.k, n: e.n, lo, hi, avg, res, pierce, effRes: DMG.effectiveRes(res, pierce), after });
  }
  { // poison (57/58 per frame x length)
    const lo = T(57), hi = T(58);
    if (hi) {
      let len = T(101) > 0 ? T(101) : T(59); const m = T(332);
      const tot = ((lo + Math.trunc(lo * m / 100)) + (hi + Math.trunc(hi * m / 100))) / 2 * len / 256;
      const res = tgt.res.poison | 0, pierce = T(336);
      elem.push({ k: 'poison', n: 'Poison', lo: 0, hi: 0, avg: tot, res, pierce, effRes: DMG.effectiveRes(res, pierce), after: DMG.elemAfterRes(tot, res, pierce, { playerOwned: true }), over: len / 25 });
    }
  }
  const elemHit = elem.reduce((a, x) => a + x.after, 0);
  const mh = CS.meleeHitChance(ct, { def: tgt.def, lvl: tgt.lvl, demon: false, undead: false, boss: tgt.primeEvil }, {});
  const im = R.ias.modes.find(x => !x.r.err);
  const aps = im ? (im.r.mh ? 25 * im.r.mh.kept.length / im.r.mh.cyc : 25 / im.r.held) : 0;
  const perHit = physHit + elemHit;
  const dps = perHit * mh.chance / 100 * aps;
  // crushing blow: fraction of current life per proc (from full life), procs per second
  const cbChance = P.cb.chance;
  const cbDiv = DMG.crushingBlowDivisor({ kind: 'monster', primeEvil: tgt.primeEvil, hpPct: 100, playerCount: 1 });
  const cbFrac = physRes >= 100 ? 0 : (1 + T(268) / 100) / cbDiv * (100 - physRes) / 100;
  const cbPerSec = aps * mh.chance / 100 * Math.min(cbChance, 100) / 100;
  // open wounds
  const ow = DMG.openWounds({ clvl: R.clvl, deepWounds: T(501), physRes, physPierce });
  // leech
  const lsDiv = [1, 2, 3][diff], physDealt8 = Math.round(physHit * 256);
  const lee = DMG.leech(physDealt8, { lifeSteal: T(60), manaSteal: T(62), drain: tgt.drain, lsDiv, msDiv: lsDiv });
  return { range, physAvg, critMul, physFactor, physHit, elem, elemHit, perHit, hit: mh.chance, ar: mh.ar, aps, dps,
    cb: { chance: cbChance, frac: cbFrac, perSec: cbPerSec, div: cbDiv }, ow: { chance: T(135), ...ow },
    leech: { life: lee.life / 256, mana: lee.mana / 256, lifePerSec: lee.life / 256 * aps * mh.chance / 100, manaPerSec: lee.mana / 256 * aps * mh.chance / 100 } };
}

/* ---- diminishing returns: +skill damage % vs -enemy resist ----
   damage multiplier for a hit = (100 + dmgPct)/100 * (100 - effRes)/100 with effRes from damage.js (pierce is ignored
   against immunes; negative resist counts half for player attacks; floor -100). */
function returnsCurve(dmgPct, baseRes, pierce, maxAdd, deb) {
  const res = deb && deb.length ? DMG.monsterResAfterCurses(baseRes, deb) : baseRes;
  const cur = (100 + dmgPct) * (100 - Math.min(DMG.effectiveRes(res, pierce), 100));
  const rows = [];
  for (let x = 0; x <= (maxAdd || 100); x += 5) {
    const a = (100 + dmgPct + x) * (100 - Math.min(DMG.effectiveRes(res, pierce), 100));
    const b = (100 + dmgPct) * (100 - Math.min(DMG.effectiveRes(res, pierce + x), 100));
    rows.push({ x, dmg: cur ? a / cur : 0, pierce: cur ? b / cur : (b > 0 ? Infinity : 0) });
  }
  const eff = DMG.effectiveRes(res, pierce);
  const oneDmg = cur ? (100 + dmgPct + 1) / (100 + dmgPct) - 1 : 0;
  const gain = n => cur ? (100 - Math.min(DMG.effectiveRes(res, pierce + n), 100)) / (100 - Math.min(eff, 100)) - 1 : 0;
  let oneRes = gain(1); if (!oneRes && eff > -100 && res < 100) oneRes = gain(2) / 2;   // below 0 resist moves in steps of 2 points
  return { rows, eff, oneDmg, oneRes, immune: res >= 100, res, baseImmune: baseRes >= 100 };
}

/* ---- 6. skill damage for every skill the character can use (skilldmg.js) ---- */
function skillTable(R) {
  const C = R.C, D = C.D, SD = root.PD2SkillDmgData;
  if (!SKD || !SD) return [];
  const ct = R.cs.ctx;
  const weaponFn = p => { const w = CS.weaponDamage(Object.assign({}, ct, { skill: { edPct: p.edPct || 0, flat: p.flat || 0, srcDam: p.src === undefined ? 128 : p.src, toHit: 0, minDmg: 0, maxDmg: 0 } })); return { min: w.min, max: w.max }; };
  const out = [];
  for (const [idStr, sk] of Object.entries(D.skills)) {
    const id = +idStr; const L = C.levels(id); if (!L.lvl) continue;
    if (sk.cl !== R.cls && !(C.R.get(97, id))) continue;
    let r = null; try { r = SKD.skillDamage(id, { D, SD, level: L.lvl, blvl: L.blvl, levelsOf: x => C.levels(+x), T: C.T, weaponFn }); } catch (e) { r = null; }
    if (!r) continue;
    const has = (r.min || r.max || (r.total && (r.total.min || r.total.max)) || (r.lines && r.lines.length));
    if (!has) continue;
    out.push({ id, n: sk.dn || sk.n, lvl: L.lvl, blvl: L.blvl, r });
  }
  return out;
}

/* ---- 7. summons and mercenary (minions.js) ---- */
function minions(R, diff) {
  const C = R.C, D = C.D, MD = root.MINION_DATA; const out = { summons: [], merc: null };
  if (!MIN || !MD) return out;
  const T = {}; C.R.each((id) => { T[id] = C.T(id); });
  const levelsOf = name => { const id = D.skillByName[String(name).toLowerCase()]; return id === undefined ? { lvl: 0, blvl: 0 } : C.levels(id); };
  for (const [name, sk] of Object.entries(MD.skills)) {
    if (!sk.summon) continue;
    const L = C.levels(sk.id); if (!L.lvl) continue;
    try { const s = MIN.summonStats(sk.id, { lvl: L.lvl, blvl: L.blvl, levelsOf, clvl: R.clvl, T, difficulty: diff }); if (s && s.count) out.summons.push(Object.assign({ skill: (D.skills[sk.id] && (D.skills[sk.id].dn || D.skills[sk.id].n)) || name }, s)); } catch (e) {}
  }
  const mm = R.C.model.merc;
  if (mm && mm.type !== undefined && mm.type !== null) {
    try {
      const lvl = mm.level || (mm.experience ? MIN.mercLevelFromExp(mm.type, mm.experience) : null);
      const ml = lvl || 1;
      const model = { level: ml };
      const MT = {}; let weapon = null;
      for (const it of mm.items || []) {
        const L = E.itemTotals(D, it, model);
        L.each((id, p, v) => { MT[id] = (MT[id] || 0) + v; });
        const b = D.items[it.code];
        if (b && b.c === 'weapon' && !weapon) weapon = { twoHanded: !!b.h2, min1: L.get(21, 0), max1: L.get(22, 0), min2: L.get(23, 0), max2: L.get(24, 0), StrBonus: b.sb, DexBonus: b.db, normalDamage: L.get(111, 0) };
      }
      const s = MIN.mercStats(lvl ? { type: mm.type, level: lvl } : { type: mm.type, experience: 0 }, MT, { difficulty: diff, weapon });
      out.merc = Object.assign({ levelKnown: !!lvl, name: mm.name }, s);
    } catch (e) { out.merc = { error: e.message }; }
  }
  return out;
}

/* ---- the mercenary: its level, the auras it carries, and its own stat view ----
   Party rules (adv/re/auras.md): a srvdofunc 65/68/25 aura gives allies its aurastats; 66/81/47 auras hit enemies. */
const ALLY_DO = [65, 68, 25], ENEMY_DO = [66, 81, 47];
function mercLevel(model) {
  const mm = model.merc; if (!mm || mm.type === undefined || mm.type === null) return 0;
  if (mm.level) return mm.level;
  if (mm.experience) { try { return MIN.mercLevelFromExp(mm.type, mm.experience); } catch (e) { return 0; } }
  return 0;
}
function mercAuras(model, D, lvlOverride) {
  const out = { ally: [], enemy: [], level: 0 };
  const mm = model.merc; if (!mm || !MIN || !root.MINION_DATA) return out;
  const lvl = lvlOverride || mercLevel(model) || model.level; out.level = lvl;
  const add = (id, l, src) => { const sk = D.skills[id]; if (!sk || !l) return; const d = sk.do; const e = { id, lvl: l, src, name: sk.dn || sk.n };
    if (ALLY_DO.includes(d)) out.ally.push(e); else if (ENEMY_DO.includes(d) || sk.aura) out.enemy.push(e); };
  try { const s = MIN.mercStats({ type: mm.type, level: lvl }, {}, {}); for (const k of s.skills || []) if (k.aura) add(k.id, k.lvl, 'your mercenary\'s aura'); } catch (e) {}
  for (const it of mm.items || []) for (const st of it.stats || []) if (st.id === 151) add(st.param, st.val, 'mercenary\'s ' + (it.name || 'item'));
  return out;
}
function mercView(R, diff, lvl) {
  const C = R.C, D = C.D, mm = C.model.merc; if (!mm || !MIN || !root.MINION_DATA) return null;
  const model = { level: lvl };
  const MT = {}, src = {}; let weapon = null;
  const note = (id, name, v) => { if (!v) return; (src[id] ||= []).push({ src: name, val: v }); };
  for (const it of mm.items || []) {
    const L = E.itemTotals(D, it, model);
    L.each((id, p, v) => { MT[id] = (MT[id] || 0) + v; note(id, it.name || it.code, v); });
    const b = D.items[it.code];
    if (b && b.c === 'weapon' && !weapon) weapon = { twoHanded: !!b.h2, min1: L.get(21, 0), max1: L.get(22, 0), min2: L.get(23, 0), max2: L.get(24, 0), StrBonus: b.sb, DexBonus: b.db, normalDamage: L.get(111, 0) };
  }
  // auras that reach the mercenary: its own ally auras (aurastats only) and the player's party auras
  const au = mercAuras(C.model, D, lvl); const auras = [];
  const evalAura = (id, l, label) => { const sk = D.skills[id]; if (!sk) return; const ctx = { D, sk, lvl: l, blvl: 0, clvl: lvl, levels: () => ({ lvl: 0, blvl: 0 }), stat: k => MT[k] || 0 };
    const rows = []; for (const [st, calc] of sk.as) { if (st < 0 || st === 6 || st === 8 || st === 10) continue; const v = E.evalCalc(calc, ctx); if (!v) continue; MT[st] = (MT[st] || 0) + v; note(st, (sk.dn || sk.n) + ' ' + l + ' (' + label + ')', v); rows.push([st, v]); }
    auras.push({ id, name: sk.dn || sk.n, lvl: l, from: label, rows }); };
  for (const a of au.ally) evalAura(a.id, a.lvl, a.src);
  for (const a of C.auraRows) { const sk = D.skills[a.id]; if (a.from === 'active skill' && sk && ALLY_DO.includes(sk.do)) evalAura(a.id, a.lvl, 'your aura'); }
  let s = null; try { s = MIN.mercStats({ type: mm.type, level: lvl }, MT, { difficulty: diff, weapon }); } catch (e) { return { error: e.message }; }
  return Object.assign({}, s, { T: id => MT[id] || 0, MT, src, auras, enemyAuras: au.enemy, weapon });
}
const API = { mercLevel, mercAuras, mercView, ALLY_DO, ENEMY_DO, debuffValues, applyDebuffs, ELEM, target, effectiveLife, monstersOnYou, attackOn, returnsCurve, skillTable, minions };
if (typeof module !== 'undefined' && module.exports) module.exports = API; else root.PD2Combat = API;
})(typeof window !== 'undefined' ? window : globalThis);
