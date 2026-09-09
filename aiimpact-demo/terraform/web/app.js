/* AIMPACT builder UI.
 *
 * Served from aimpact.<domain>; the API is reached at /api/* on the same
 * CloudFront distribution, so every call here is same-origin and there is no
 * CORS preflight to pay for on a slow connection.
 *
 * No framework and no build step: on venue wifi with 200 phones, the cheapest
 * bundle is the one that does not exist.
 */
'use strict';

var API = '/api';

/* The prompt box opens with an editable example rather than empty. A blank
 * textarea in front of someone who has never written a prompt is where these
 * sessions stall; a concrete example they can overwrite is not. */
var SEED =
  'Warung Nasi Goreng Budi di Telanaipura, Jambi. Buka setiap hari jam 5 sore ' +
  'sampai 11 malam. Menu andalan nasi goreng kampung Rp15.000, nasi goreng ' +
  'seafood Rp22.000, dan es teh manis Rp5.000. Rasanya pedas gurih, porsinya ' +
  'besar, cocok untuk makan malam keluarga. Pesan lewat WhatsApp 0812-3456-7890.';

var CHIPS = [
  ['+ Jam buka', ' Buka setiap hari jam 08.00 sampai 20.00.'],
  ['+ Alamat', ' Lokasi di Jl. ... , Kota Jambi.'],
  ['+ Nomor WA', ' Pesan lewat WhatsApp 08xx-xxxx-xxxx.'],
  ['+ Pengantaran', ' Bisa diantar, gratis ongkir dalam kota.'],
  ['+ Keunggulan', ' Bahan segar setiap hari, harga bersahabat.']
];

var state = { token: null, slug: null, remaining: null, jobId: null, timer: null };

function $(id) { return document.getElementById(id); }

function show(id) {
  var steps = document.querySelectorAll('.step');
  for (var i = 0; i < steps.length; i++) steps[i].classList.remove('on');
  $(id).classList.add('on');
  window.scrollTo(0, 0);
}

function fail(id, msg) {
  var el = $(id);
  el.textContent = msg;
  el.classList.add('on');
}

function clearFail(id) { $(id).classList.remove('on'); }

/* Every API error the participant can actually see gets a sentence in
 * Indonesian saying what to do, never a status code. */
function explain(status, body) {
  if (status === 401 || status === 403) return 'Kode tidak berlaku. Periksa kembali lembar peserta Anda.';
  if (status === 404) return 'Kode tidak ditemukan. Pastikan tidak ada huruf yang tertukar.';
  if (status === 409) return 'Kode ini sudah dipakai di perangkat lain.';
  if (status === 429) return 'Anda sudah mencapai batas pembuatan. Hubungi panitia bila perlu tambahan.';
  if (status === 501) return 'Layanan belum aktif. Sampaikan ke panitia.';
  if (status >= 500) return 'Server sedang sibuk. Coba lagi sebentar lagi.';
  if (body && body.message) return body.message;
  return 'Terjadi kesalahan. Coba lagi.';
}

function api(method, path, body) {
  var opts = { method: method, headers: {} };
  if (state.token) opts.headers['authorization'] = 'Bearer ' + state.token;
  if (body) {
    opts.headers['content-type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  return fetch(API + path, opts).then(function (res) {
    return res.json().catch(function () { return {}; }).then(function (json) {
      if (!res.ok) {
        var e = new Error(explain(res.status, json));
        e.status = res.status;
        throw e;
      }
      return json;
    });
  }, function () {
    throw new Error('Tidak ada koneksi. Periksa sinyal Anda, lalu coba lagi.');
  });
}

function remainingText() {
  if (state.remaining === null) return '';
  if (state.remaining <= 0) return 'Batas pembuatan sudah habis.';
  return 'Sisa kesempatan: ' + state.remaining + '×';
}

/* --- 1. redeem ---------------------------------------------------------- */

function redeem() {
  var code = $('code').value.trim().toUpperCase();
  if (code.length < 4) { fail('err-code', 'Masukkan kode lengkap dari lembar peserta.'); return; }

  clearFail('err-code');
  var btn = $('btn-code');
  btn.disabled = true;
  btn.textContent = 'Memeriksa…';

  api('POST', '/redeem', { code: code }).then(function (r) {
    state.token = r.token;
    state.slug = r.slug;
    state.remaining = typeof r.remaining === 'number' ? r.remaining : null;
    $('count').textContent = remainingText();
    show('s-prompt');
  }).catch(function (e) {
    fail('err-code', e.message);
  }).then(function () {
    btn.disabled = false;
    btn.textContent = 'Lanjut';
  });
}

/* --- 2. generate -------------------------------------------------------- */

function generate() {
  var text = $('prompt').value.trim();
  if (text.length < 25) {
    fail('err-gen', 'Ceritakan sedikit lebih lengkap — nama usaha, menu, dan nomor WhatsApp.');
    return;
  }

  clearFail('err-gen');
  var btn = $('btn-gen');
  btn.disabled = true;

  api('POST', '/generate', { prompt: text }).then(function (r) {
    state.jobId = r.job_id;
    show('s-work');
    mark('b1', 'now');
    poll();
  }).catch(function (e) {
    fail('err-gen', e.message);
  }).then(function () {
    btn.disabled = false;
  });
}

/* --- 3. poll ------------------------------------------------------------ */

function mark(id, cls) {
  var el = $(id);
  el.classList.remove('now', 'did');
  if (cls) el.classList.add(cls);
}

function poll() {
  var tries = 0;
  state.timer = setInterval(function () {
    tries++;
    /* ~2 minutes, comfortably past the worker's 120s ceiling. */
    if (tries > 60) {
      clearInterval(state.timer);
      fail('err-work', 'Terlalu lama menunggu. Sampaikan ke panitia.');
      return;
    }

    api('GET', '/status/' + encodeURIComponent(state.jobId)).then(function (r) {
      if (r.status === 'running') { mark('b1', 'did'); mark('b2', 'now'); }
      if (r.status === 'done') {
        clearInterval(state.timer);
        mark('b1', 'did'); mark('b2', 'did'); mark('b3', 'did');
        finish(r.url);
      }
      if (r.status === 'error') {
        clearInterval(state.timer);
        fail('err-work', r.message || 'Gagal membuat halaman. Coba lagi.');
      }
    }).catch(function (e) {
      /* A single failed poll is usually a dropped packet, not a dead job.
       * Only surface it once it has failed repeatedly. */
      if (tries > 5) {
        clearInterval(state.timer);
        fail('err-work', e.message);
      }
    });
  }, 2000);
}

/* --- 4. done ------------------------------------------------------------ */

function finish(url) {
  var a = $('live');
  a.href = url;
  a.textContent = url.replace(/^https?:\/\//, '');
  if (state.remaining !== null) state.remaining--;
  $('count2').textContent = remainingText();
  show('s-done');
}

function share() {
  var url = $('live').href;
  var text = 'Ini website usaha saya: ' + url;
  if (navigator.share) {
    navigator.share({ title: 'Website usaha saya', text: text, url: url }).catch(function () {});
  } else {
    window.open('https://wa.me/?text=' + encodeURIComponent(text), '_blank', 'noopener');
  }
}

function copy() {
  var url = $('live').href;
  var btn = $('btn-copy');
  var done = function () {
    btn.textContent = 'Tersalin ✓';
    setTimeout(function () { btn.textContent = 'Salin tautan'; }, 1800);
  };
  if (navigator.clipboard) {
    navigator.clipboard.writeText(url).then(done, done);
  } else {
    var t = document.createElement('textarea');
    t.value = url;
    document.body.appendChild(t);
    t.select();
    try { document.execCommand('copy'); } catch (e) { /* nothing useful to do */ }
    document.body.removeChild(t);
    done();
  }
}

/* --- wiring ------------------------------------------------------------- */

function init() {
  $('prompt').value = SEED;

  var box = $('chips');
  CHIPS.forEach(function (pair) {
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'chip';
    b.textContent = pair[0];
    b.addEventListener('click', function () {
      var ta = $('prompt');
      ta.value = ta.value.replace(/\s+$/, '') + pair[1];
      ta.focus();
      ta.setSelectionRange(ta.value.length, ta.value.length);
    });
    box.appendChild(b);
  });

  $('btn-code').addEventListener('click', redeem);
  $('code').addEventListener('keydown', function (e) { if (e.key === 'Enter') redeem(); });
  $('btn-gen').addEventListener('click', generate);
  $('btn-share').addEventListener('click', share);
  $('btn-copy').addEventListener('click', copy);
  $('btn-again').addEventListener('click', function () {
    clearFail('err-gen');
    show('s-prompt');
  });
}

document.addEventListener('DOMContentLoaded', init);
