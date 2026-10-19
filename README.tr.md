# lanerelay

`lanerelay` — tek görev, birden fazla AI kodlama CLI'ı. Öndeki CLI 5 saatlik
penceresini, haftalık kotasını veya bir 429'u doldurduğunda, `lanerelay` o hattı
sıfırlanma zamanına kadar engelli olarak işaretler; görevi (o ana kadar
yapılanlar ve mevcut `git diff` özetiyle birlikte) sıradaki hatta devreder.
Tercih edilen hattın sıfırlanma süresi geçince yeni iş yine ona döner.

Claude Code, Codex, Gemini CLI, GLM, OpenCode, Aider, Cursor... Her birinin
kendi kota penceresi var. `lanerelay`, abonelikler sıfırlanırken görevinizi
durmadan ilerleten röle koşucusudur.

## 30 saniyelik başlangıç

```bash
npx lanerelay init        # claude/codex/gemini hatlarıyla lanerelay.yaml yazar
# lane komutlarını kurulu CLI'larınıza göre düzenleyin
npx lanerelay run "src/parser içindeki bozuk testi düzelt"
```

`lanerelay` ilk hattı çalıştırır; kullanım limiti mesajıyla çıkarsa görev bir
devir notuyla bir sonraki hatta geçer.

## Komutlar

| Komut | Ne yapar |
|---|---|
| `lanerelay init` | Başlangıç `lanerelay.yaml` yazar (üzerine yazmaz). |
| `lanerelay run "görev"` | Görevi hatlar boyunca koşturur; çıkış kodu: 0 bitti / 2 hepsi engelli / 3 hata / 4 bekleme zaman aşımı. |
| `lanerelay run --chain a,b,c "görev"` | Hat sırasını zorla veya config'teki isimli zinciri kullan. |
| `lanerelay run --resume <id>` | Kesilmiş/hatalı/engelli bir koşuyu devam ettir (id'ler `lanerelay report`'ta). Sıradaki hat tüm deneme geçmişini devir notu olarak alır. |
| `lanerelay run --no-wait` | Tüm hatlar engelliyken uyumak yerine çık. |
| `lanerelay run --diff none\|stat\|full` | Devir istemine ne kadar çalışma ağacı bilgisi girsin (varsayılan `stat`; `full` sınırlı `git diff` yamasını gömer). |
| `lanerelay status` | Hat başına `available` / `blocked until HH:MM` / `unknown`, `[leased by <koşu>]` paralel kilit bilgisiyle, artı devam ettirilebilir koşular (`--json`). |
| `lanerelay top` | Canlı pano: hat başına engel geri sayımı, kota göstergeleri, hangi görev hangi hatta, kuyruk derinliği, devam ettirilebilir koşular. `--interval <s>`, `--once` / boru hattında tek kare, `q` çıkar. |
| `lanerelay probe <hat>` / `lanerelay probe --all` | Hatta küçük bir deneme istemi gönderir: `available`, `limited` (gerçek sıfırlanma zamanını state'e yazar), `auth-error` (bozuk anahtar/plan — 24s engeller), `error`, `timeout`. `--prompt`, `--timeout <s>`, `--json`. |
| `lanerelay report` | Koşu geçmişi: hat başına deneme istatistikleri (done/limited/failed/timeout), kuyruk sonuçları, devam ettirilebilir koşular (`--json`, `--jsonl` satır başına bir kayıt akıtır). `lanerelay report --lane <ad>` tek hattı açar: kanıt ve log referanslarıyla tüm denemeler. |
| `lanerelay add "görev"` | İzleyici için görevi kuyruğa ekle. `lanerelay add --file gorevler.txt` (veya stdin için `-`) her satırdan bir görev ekler — boş satırlar ve `#` yorumları atlanır. |
| `lanerelay queue` | Bekleyen / çalışan / biten / hatalı öğeleri listele (koşu kaydı id'siyle); ertelenen öğeler `[deferred until HH:MM xN]` etiketi taşır. |
| `lanerelay watch` | Daemon: kuyruğu tüket (`--once` boşalınca çıkar, `--poll N`). `--jobs N` aynı anda N görev koşturur, her biri *farklı* hatta (`.lanerelay/leases/` altında hat başına kilit); config'te `queue.jobs` aynı işi yapar. Tüm hatlar engelliyken görev **ertelenir**, hata olmaz: ilk hat sıfırlanmasına kadar bekleyene döner (`queue.maxDefers`, varsayılan 10). Çıktılar karışır — `-q` kullanıp `lanerelay log`'a bakın. |
| `lanerelay log [seçici]` | `.lanerelay/logs` altındaki deneme logunu gösterir (son 200 satır). Seçici: koşu id öneki (`lanerelay log r-abc1`), kuyruk öğesi id'si, hat adı (`lanerelay log claude`) veya dosya adı parçası; seçici yoksa en yeni log. `--lines/-n` (0 = tüm dosya), `--follow/-f` (canlı takip), `--list` (son dosyalar). |
| `lanerelay prune [--days N]` | N günden eski koşu kayıtlarını sil (varsayılan 30). |
| `lanerelay unblock [hat]` | Hattın engelli durumunu elle temizle. |
| `lanerelay doctor` | Uçuş öncesi kontrol: config ayrışır, her hattın çalıştırılabiliri bulunur (PATH veya disk), `{{prompt}}` yuvası var, `.lanerelay` dizinleri yazılabilir, state dosyası geçerli, izleyici kilidi ve hat kilitleri bayat değil. `--json`; herhangi bir FAIL'de çıkış 1. |

## Nasıl çalışır

- Her CLI için desen kütüphanesi (`src/patterns.ts`) alt sürecin çıktısının
  son kısmını kota/429/RESOURCE_EXHAUSTED mesajları için tarar; sıfırlanma
  zamanını `try again in 40 minutes`, `resets at 12pm`, `retryDelay:"45s"`,
  `reached|<epoch>`, ISO tarihleri gibi biçimlerden çözer. Geçici hatalar
  (`overloaded_error`, 5xx, yeniden denenen 429'lar) limit sayılmaz.
- Durum `.lanerelay/state.json` dosyasında tutulur: hangi hat engelli, ne zamana
  kadar, neden.
- Devir istemi = göreviniz + "önceki ajanlar bunu zaten denedi" notu +
  `git diff --stat` + önceki denemelerin çıktı kuyrukları. Sonraki ajan aynı
  çalışma ağacında devam eder — değişiklikler kopyalanmaz, paylaşılır.
- Hooks ile limit/devir/bitirme/hata olaylarına kabuk komutu veya webhook
  (JSON POST) bağlayabilirsiniz.
- Koşu kayıtları `.lanerelay/runs/<id>.json` altında tutulur ve her denemeden sonra
  yeniden yazılır. `lanerelay` görev ortasında öldürülürse (Ctrl+C, OOM) kayıt
  `interrupted` olur; `lanerelay run --resume <id>` aynı görevi tam deneme
  geçmişiyle devam ettirir.
- Hat sırası = maliyet sınıfı (önce ücretli) → gözlenen kalan kota → öncelik.
  CLI bir kullanım göstergesi yazdırırsa ("usage: 72%", "12% quota left")
  lanerelay bunu hatırlar (gösterge penceresine göre ayrı ayrı: oturum 8s, günlük
  36s, haftalık 9g, aylık 35g, etiketsiz 24s eskime) ve görev ortasında
  ölme ihtimali en düşük hattı öne alır — birden fazla gösterge varsa en
  kötü penceresi kazanır. Açık `--chain` sırası her zaman kazanır.
- Hat kilitleri `.lanerelay/leases/<hat>.json` altında tutulur ve eşzamanlılığı
  güvenli kılar: her deneme o hattın kilidini alır (atomik dosya, ölü
  süreçler geri kazanılır). Böylece `lanerelay watch --jobs 2` ile eşzamanlı bir
  `lanerelay run` aynı aboneliği iki görev için aynı anda tüketmez.
- Windows'ta lane komutları `cmd /c` ile çalışır ve istem `%LR_PROMPT%`
  ortam değişkeniyle gelir; POSIX'te `LR_PROMPT` da export edilir.

Detaylı yapılandırma, limitler ve geliştirme notları için `README.md`'ye
bakın. Node'suz çalışan tek dosyalık ikililer `scripts/compile.sh`
(bun build --compile) ile üretilir. MIT lisansı.
