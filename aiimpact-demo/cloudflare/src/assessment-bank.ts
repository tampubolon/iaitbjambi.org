/**
 * Pre-test and post-test question bank.
 *
 * Content drawn from the AIMPACT "AI untuk UMKM" deck, ten questions each,
 * four options, ten points per correct answer. The pre-test asks what things
 * are; the post-test asks the participant to apply the same ideas, so the
 * difference between the two scores means something more than familiarity
 * with the wording.
 *
 * The correct answers live here, in the Worker, and are never sent to the
 * browser. render() strips them; scoring happens server-side in score().
 */

export interface Question {
  id: string;
  q: string;
  /** Option letter to text. */
  o: Record<string, string>;
  /** The correct option letter. Server-side only. */
  a: string;
}

export type Kind = "pre" | "post";

export const POINTS_PER_CORRECT = 10;

const PRE: Question[] = [
  {
    id: "PRE-01",
    q: "Sebelum memilih alat AI untuk usaha, langkah pertama yang paling tepat adalah …",
    o: { A: "Memilih alat dengan fitur paling banyak", B: "Mengidentifikasi masalah bisnis dan proses yang menyita waktu", C: "Membeli langganan AI yang sedang populer", D: "Memindahkan semua proses bisnis ke AI" },
    a: "B",
  },
  {
    id: "PRE-02",
    q: "Ketika AI memberikan saran untuk bisnis, siapa yang bertanggung jawab atas keputusan akhirnya?",
    o: { A: "Penyedia aplikasi AI", B: "AI yang memberikan saran", C: "Pelanggan yang menerima hasilnya", D: "Pemilik bisnis yang menggunakan saran tersebut" },
    a: "D",
  },
  {
    id: "PRE-03",
    q: "Prompt mana yang paling membantu AI membuat materi promosi yang sesuai kebutuhan?",
    o: { A: "Bertindak sebagai pemasar kopi lokal. Target pekerja 25–35 tahun yang mencari tempat WFC. Buat 5 ide Reels, maksimal 2 kalimat per ide.", B: "Buat promosi kopi yang bagus.", C: "Buat promosi seperti merek kopi terkenal.", D: "Buat sebanyak mungkin ide promosi kopi." },
    a: "A",
  },
  {
    id: "PRE-04",
    q: "Apa fungsi Ask Back dalam prompt?",
    o: { A: "Meminta AI mengulangi jawaban dengan kata berbeda", B: "Meminta AI memilih alat lain", C: "Meminta AI bertanya jika informasi belum lengkap", D: "Meminta AI langsung mengambil keputusan" },
    a: "C",
  },
  {
    id: "PRE-05",
    q: "Contoh penggunaan AI multimodal adalah …",
    o: { A: "Meminta AI memperpendek satu paragraf teks", B: "Mengunggah foto produk dan meminta AI menyusun deskripsinya", C: "Meminta AI menulis ulang judul dalam bahasa Indonesia", D: "Meminta AI membuat daftar ide dari instruksi teks saja" },
    a: "B",
  },
  {
    id: "PRE-06",
    q: "Apa tujuan utama landing page bisnis ?",
    o: { A: "Memperkenalkan produk dan mengarahkan calon pelanggan ke WhatsApp", B: "Menggantikan seluruh proses operasional usaha", C: "Menyimpan semua transaksi keuangan pelanggan", D: "Menjadi aplikasi internal pengelolaan stok" },
    a: "A",
  },
  {
    id: "PRE-07",
    q: "Pasangan komponen aplikasi dan fungsinya yang tepat adalah …",
    o: { A: "Frontend menyimpan transaksi, backend menampilkan tombol, database memproses login", B: "Frontend memproses login, backend menyimpan transaksi, database menampilkan formulir", C: "Frontend menampilkan formulir, backend menyimpan warna tema, database menghitung setiap permintaan", D: "Frontend menampilkan formulir, backend memproses permintaan, database menyimpan transaksi" },
    a: "D",
  },
  {
    id: "PRE-08",
    q: "Apa yang dimaksud dengan vibe coding dalam materi ini?",
    o: { A: "Membuat desain aplikasi hanya dengan memilih warna", B: "Menggunakan aplikasi tanpa menjelaskan kebutuhan", C: "Menjelaskan kebutuhan aplikasi dengan bahasa sehari-hari agar AI membantu membuatnya", D: "Menyalin kode aplikasi lain tanpa memeriksa fungsinya" },
    a: "C",
  },
  {
    id: "PRE-09",
    q: "Data minimum apa yang disarankan dicatat untuk setiap transaksi?",
    o: { A: "Tanggal, kategori, jumlah, jenis transaksi, dan keterangan", B: "Nama usaha, logo, slogan, alamat, dan warna merek", C: "Jumlah pengikut, jumlah komentar, dan jadwal unggahan", D: "Nama pemilik, target penjualan, dan daftar kompetitor" },
    a: "A",
  },
  {
    id: "PRE-10",
    q: "Pernyataan mana yang tepat tentang saldo kas dan laba?",
    o: { A: "Saldo kas selalu sama dengan laba", B: "Laba cukup dihitung dari seluruh uang yang masuk", C: "Saldo kas hanya perlu dicatat saat mengajukan pembiayaan", D: "Saldo kas berbeda dari laba karena perhitungan laba memerlukan perlakuan biaya dan persediaan yang tepat" },
    a: "D",
  },
];

const POST: Question[] = [
  {
    id: "POST-01",
    q: "Pemilik toko menghabiskan dua jam setiap malam merekap pesanan WhatsApp. Langkah awal penerapan AI yang paling tepat adalah …",
    o: { A: "Membeli beberapa alat AI untuk dibandingkan sekaligus", B: "Membuat chatbot untuk semua kegiatan usaha", C: "Memetakan alur rekap dan data pesanan, lalu memilih bantuan AI yang sesuai", D: "Mengganti kanal penjualan sebelum memeriksa proses rekap" },
    a: "C",
  },
  {
    id: "POST-02",
    q: "AI menyarankan paket promosi yang ternyata sulit dipenuhi kapasitas produksi usaha. Apa tindakan terbaik pemilik usaha?",
    o: { A: "Meninjau kapasitas dan biaya, memperbaiki instruksi, lalu memutuskan promosi yang layak", B: "Mengikuti saran karena AI sudah melakukan analisis", C: "Meminta AI menjalankan promosi tanpa pemeriksaan tambahan", D: "Memilih saran AI yang terdengar paling meyakinkan" },
    a: "A",
  },
  {
    id: "POST-03",
    q: "AI menghasilkan caption katering yang terlalu umum. Perbaikan prompt yang paling tepat adalah …",
    o: { A: "Tambahkan instruksi: buat lebih menarik dan viral", B: "Tambahkan instruksi: buat sebanyak mungkin variasi", C: "Tambahkan instruksi: tiru promosi katering terbesar", D: "Jelaskan peran AI, target pembeli, paket dan harga, tujuan promosi, serta batas panjang caption" },
    a: "D",
  },
  {
    id: "POST-04",
    q: "Anda akan meminta AI membuat landing page, tetapi target pelanggan dan harga produk belum jelas. Instruksi tambahan yang paling tepat adalah …",
    o: { A: "Gunakan target dan harga dari usaha lain", B: "Tanyakan informasi yang masih dibutuhkan sebelum membuat halaman", C: "Kosongkan semua bagian yang memerlukan informasi bisnis", D: "Tentukan sendiri target dan harga yang terdengar menarik" },
    a: "B",
  },
  {
    id: "POST-05",
    q: "Pemilik usaha mengunggah rekaman suara pelanggan dan foto kemasan, lalu meminta AI merangkum masukan perbaikan produk. Ini merupakan contoh …",
    o: { A: "Basic web karena hasilnya dapat ditampilkan di halaman", B: "Otomasi karena semua keputusan sudah berjalan otomatis", C: "Multimodal karena AI menggunakan suara dan gambar", D: "Meta prompting karena AI membuat prompt baru" },
    a: "C",
  },
  {
    id: "POST-06",
    q: "Landing page sudah memperkenalkan masalah pelanggan, produk, manfaat, testimoni, dan FAQ. Agar sesuai tujuan demo, bagian apa yang perlu ditambahkan?",
    o: { A: "Tabel kode program pembuat halaman", B: "Riwayat perubahan desain halaman", C: "Daftar semua alat AI yang dipakai", D: "Ajakan yang jelas dan tombol untuk menghubungi WhatsApp" },
    a: "D",
  },
  {
    id: "POST-07",
    q: "Dalam aplikasi pencatatan, pengguna mengisi formulir, server memvalidasi jumlah, lalu sistem menyimpan transaksi. Urutan komponen yang terlibat adalah …",
    o: { A: "Database, frontend, backend", B: "Frontend, backend, database", C: "Backend, database, frontend", D: "Frontend, database, backend" },
    a: "B",
  },
  {
    id: "POST-08",
    q: "AI sudah membuat prototipe pencatatan transaksi. Sebelum digunakan untuk kegiatan usaha, langkah berikutnya yang paling tepat adalah …",
    o: { A: "Menguji input dan perhitungan dengan contoh transaksi, memeriksa penyimpanan, lalu memperbaiki kesalahan", B: "Langsung memasukkan seluruh transaksi karena halaman sudah tampil", C: "Menambahkan banyak fitur sebelum mencoba fitur dasar", D: "Mempublikasikan aplikasi dan menyerahkan pengujian kepada pelanggan" },
    a: "A",
  },
  {
    id: "POST-09",
    q: "Rekap bulanan tidak konsisten karena kategori berbeda-beda dan transaksi pribadi bercampur dengan transaksi usaha. Perbaikan paling tepat adalah …",
    o: { A: "Menghapus transaksi yang sulit dikelompokkan", B: "Mengganti tampilan dashboard tanpa mengubah data", C: "Menyatukan semua transaksi ke kategori lain-lain", D: "Menyeragamkan kategori, melengkapi data transaksi, dan memisahkan uang usaha dari uang pribadi" },
    a: "D",
  },
  {
    id: "POST-10",
    q: "Dashboard menunjukkan saldo kas Rp5 juta. Pemilik ingin menyebut seluruhnya sebagai laba bulan ini. Tindakan yang tepat adalah …",
    o: { A: "Menyetujui karena saldo kas positif berarti laba sama besar", B: "Memeriksa pendapatan, biaya, dan persediaan sebelum menghitung laba", C: "Menghitung semua pemasukan sebagai laba tanpa melihat pengeluaran", D: "Menggunakan saldo kas sebagai laba jika transaksi tersimpan di browser" },
    a: "B",
  },
];

export function bank(kind: Kind): Question[] {
  return kind === "pre" ? PRE : POST;
}

/** The questions as the browser may see them: no answers. */
export function forBrowser(kind: Kind): { id: string; q: string; o: Record<string, string> }[] {
  return bank(kind).map(({ id, q, o }) => ({ id, q, o }));
}

/**
 * Marks a submission.
 *
 * Unanswered or unrecognised questions score zero rather than failing the
 * whole submission: a participant who loses signal mid-test and resubmits
 * should get a score, not an error at a registration desk.
 */
export function score(kind: Kind, answers: Record<string, string>): number {
  let n = 0;
  for (const question of bank(kind)) {
    if (answers[question.id] === question.a) n += POINTS_PER_CORRECT;
  }
  return n;
}
