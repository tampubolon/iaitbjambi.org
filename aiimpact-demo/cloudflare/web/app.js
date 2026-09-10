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

/**
 * Polls until the job finishes, backing off as it goes.
 *
 * A fixed 2s interval was the single biggest reliability risk in the system.
 * With a queue that can take minutes to drain, 200 participants polling every
 * two seconds generates more requests than the Worker plan allows in a day --
 * and exceeding it stops the Worker for everyone, not just the impatient.
 *
 * Backing off cuts that by roughly three quarters while keeping the first
 * half-minute responsive, which is when most jobs finish anyway.
 */
function pollDelay(elapsedMs) {
  if (elapsedMs < 30000) return 2000;
  if (elapsedMs < 90000) return 5000;
  return 10000;
}

function humanSeconds(ms) {
  var s = Math.round(ms / 1000);
  if (s < 60) return s + ' detik';
  var m = Math.floor(s / 60);
  var r = s % 60;
  return m + ' menit' + (r ? ' ' + r + ' detik' : '');
}

/* Someone at the back of a 200-person queue waits minutes while the screen
 * says "sekitar 30 detik". Without a running counter that reads as broken,
 * and they resubmit -- spending another generation and lengthening the queue
 * for everyone. */
function showElapsed(ms) {
  var el = $('elapsed');
  if (!el) return;
  if (ms < 20000) { el.innerHTML = ''; return; }
  var msg = 'Sudah menunggu <b>' + humanSeconds(ms) + '</b>.';
  if (ms > 45000) msg += '<br>Antrean sedang ramai. Halaman Anda tetap diproses — jangan tutup atau ulangi.';
  el.innerHTML = msg;
}

function poll() {
  var started = Date.now();
  var softFails = 0;

  var tick = function () {
    var elapsed = Date.now() - started;
    showElapsed(elapsed);

    /* Ten minutes covers a full queue drain with room to spare. */
    if (elapsed > 600000) {
      fail('err-work', 'Terlalu lama menunggu. Sampaikan ke panitia.');
      return;
    }

    api('GET', '/status/' + encodeURIComponent(state.jobId)).then(function (r) {
      softFails = 0;
      if (r.status === 'running') { mark('b1', 'did'); mark('b2', 'now'); }
      if (r.status === 'done') {
        mark('b1', 'did'); mark('b2', 'did'); mark('b3', 'did');
        showElapsed(0);
        finish(r.url);
        return;
      }
      if (r.status === 'error') {
        fail('err-work', r.message || 'Gagal membuat halaman. Coba lagi.');
        return;
      }
      state.timer = setTimeout(tick, pollDelay(elapsed));
    }).catch(function (e) {
      /* A single failed poll is usually a dropped packet on a busy venue
       * network, not a dead job. Only surface it after several in a row. */
      softFails++;
      if (softFails > 5) {
        fail('err-work', e.message);
        return;
      }
      state.timer = setTimeout(tick, pollDelay(elapsed));
    });
  };

  tick();
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
    if (state.timer) clearTimeout(state.timer);
    show('s-prompt');
  });
}

document.addEventListener('DOMContentLoaded', init);
