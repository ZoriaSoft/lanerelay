# quota-pilot

`qp` — tek görev, birden fazla AI kodlama CLI'ı. Öndeki CLI 5 saatlik
penceresini, haftalık kotasını veya bir 429'u doldurduğunda, `qp` o hattı
sıfırlanma zamanına kadar engelli olarak işaretler; görevi (o ana kadar
yapılanlar ve mevcut `git diff` özetiyle birlikte) sıradaki hatta devreder.
Tercih edilen hattın sıfırlanma süresi geçince yeni iş yine ona döner.

Claude Code, Codex, Gemini CLI, GLM, OpenCode, Aider, Cursor... Her birinin
kendi kota penceresi var. `qp`, abonelikler sıfırlanırken görevinizi
durmadan ilerleten röle koşucusudur.

## 30 saniyelik başlangıç

```bash
npx quota-pilot init        # claude/codex/gemini hatlarıyla quota-pilot.yaml yazar
# lane komutlarını kurulu CLI'larınıza göre düzenleyin
npx quota-pilot run "src/parser içindeki bozuk testi düzelt"
```

`qp` ilk hattı çalıştırır; kullanım limiti mesajıyla çıkarsa görev bir
devir notuyla bir sonraki hatta geçer.

## Komutlar

| Komut | Ne yapar |
|---|---|
| `qp init` | Başlangıç `quota-pilot.yaml` yazar (üzerine yazmaz). |
| `qp run "görev"` | Görevi hatlar boyunca koşturur; çıkış kodu: 0 bitti / 2 hepsi engelli / 3 hata / 4 bekleme zaman aşımı. |
| `qp run --chain a,b,c "görev"` | Hat sırasını zorla veya config'teki isimli zinciri kullan. |
| `qp run --resume <id>` | Kesilmiş/hatalı/engelli bir koşuyu devam ettir (id'ler `qp report`'ta). Sıradaki hat tüm deneme geçmişini devir notu olarak alır. |
| `qp run --no-wait` | Tüm hatlar engelliyken uyumak yerine çık. |
| `qp run --diff none\|stat\|full` | Devir istemine ne kadar çalışma ağacı bilgisi girsin (varsayılan `stat`; `full` sınırlı `git diff` yamasını gömer). |
| `qp status` | Hat başına `available` / `blocked until HH:MM` / `unknown`, `[leased by <koşu>]` paralel kilit bilgisiyle, artı devam ettirilebilir koşular (`--json`). |
| `qp top` | Canlı pano: hat başına engel geri sayımı, kota göstergeleri, hangi görev hangi hatta, kuyruk derinliği, devam ettirilebilir koşular. `--interval <s>`, `--once` / boru hattında tek kare, `q` çıkar. |
| `qp probe <hat>` / `qp probe --all` | Hatta küçük bir deneme istemi gönderir: `available`, `limited` (gerçek sıfırlanma zamanını state'e yazar), `auth-error` (bozuk anahtar/plan — 24s engeller), `error`, `timeout`. `--prompt`, `--timeout <s>`, `--json`. |
| `qp report` | Koşu geçmişi: hat başına deneme istatistikleri (done/limited/failed/timeout), kuyruk sonuçları, devam ettirilebilir koşular (`--json`). `qp report --lane <ad>` tek hattı açar: kanıt ve log referanslarıyla tüm denemeler. |
| `qp add "görev"` | İzleyici için görevi kuyruğa ekle. |
| `qp queue` | Bekleyen / çalışan / biten / hatalı öğeleri listele (koşu kaydı id'siyle); ertelenen öğeler `[deferred until HH:MM xN]` etiketi taşır. |
| `qp watch` | Daemon: kuyruğu tüket (`--once` boşalınca çıkar, `--poll N`). `--jobs N` aynı anda N görev koşturur, her biri *farklı* hatta (`.qp/leases/` altında hat başına kilit); config'te `queue.jobs` aynı işi yapar. Tüm hatlar engelliyken görev **ertelenir**, hata olmaz: ilk hat sıfırlanmasına kadar bekleyene döner (`queue.maxDefers`, varsayılan 10). Çıktılar karışır — `-q` kullanıp `qp log`'a bakın. |
| `qp log [seçici]` | `.qp/logs` altındaki deneme logunu gösterir (son 200 satır). Seçici: koşu id öneki (`qp log r-abc1`), kuyruk öğesi id'si, hat adı (`qp log claude`) veya dosya adı parçası; seçici yoksa en yeni log. `--lines/-n` (0 = tüm dosya), `--follow/-f` (canlı takip), `--list` (son dosyalar). |
| `qp prune [--days N]` | N günden eski koşu kayıtlarını sil (varsayılan 30). |
| `qp unblock [hat]` | Hattın engelli durumunu elle temizle. |

## Nasıl çalışır

- Her CLI için desen kütüphanesi (`src/patterns.ts`) alt sürecin çıktısının
  son kısmını kota/429/RESOURCE_EXHAUSTED mesajları için tarar; sıfırlanma
  zamanını `try again in 40 minutes`, `resets at 12pm`, `retryDelay:"45s"`,
  `reached|<epoch>`, ISO tarihleri gibi biçimlerden çözer. Geçici hatalar
  (`overloaded_error`, 5xx, yeniden denenen 429'lar) limit sayılmaz.
- Durum `.qp/state.json` dosyasında tutulur: hangi hat engelli, ne zamana
  kadar, neden.
- Devir istemi = göreviniz + "önceki ajanlar bunu zaten denedi" notu +
  `git diff --stat` + önceki denemelerin çıktı kuyrukları. Sonraki ajan aynı
  çalışma ağacında devam eder — değişiklikler kopyalanmaz, paylaşılır.
- Hooks ile limit/devir/bitirme/hata olaylarına kabuk komutu veya webhook
  (JSON POST) bağlayabilirsiniz.
- Koşu kayıtları `.qp/runs/<id>.json` altında tutulur ve her denemeden sonra
  yeniden yazılır. `qp` görev ortasında öldürülürse (Ctrl+C, OOM) kayıt
  `interrupted` olur; `qp run --resume <id>` aynı görevi tam deneme
  geçmişiyle devam ettirir.
- Hat sırası = maliyet sınıfı (önce ücretli) → gözlenen kalan kota → öncelik.
  CLI bir kullanım göstergesi yazdırırsa ("usage: 72%", "12% quota left")
  qp bunu hatırlar (24 saat eskime) ve görev ortasında ölme ihtimali en düşük
  hattı öne alır. Açık `--chain` sırası her zaman kazanır.
- Hat kilitleri `.qp/leases/<hat>.json` altında tutulur ve eşzamanlılığı
  güvenli kılar: her deneme o hattın kilidini alır (atomik dosya, ölü
  süreçler geri kazanılır). Böylece `qp watch --jobs 2` ile eşzamanlı bir
  `qp run` aynı aboneliği iki görev için aynı anda tüketmez.
- Windows'ta lane komutları `cmd /c` ile çalışır ve istem `%QP_PROMPT%`
  ortam değişkeniyle gelir; POSIX'te `QP_PROMPT` da export edilir.

Detaylı yapılandırma, limitler ve geliştirme notları için `README.md`'ye
bakın. Node'suz çalışan tek dosyalık ikililer `scripts/compile.sh`
(bun build --compile) ile üretilir. MIT lisansı.
