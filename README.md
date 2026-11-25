# TugbayReader

TugbayReader, Windows için Türkçe bir PDF düzenleyicidir. Belgeleri yerel olarak işler.

- PDF birleştirme, sayfa ekleme, çıkarma, sıralama, döndürme ve kırpma
- Metin ve görsel düzenleme, çizimle imza, not, vurgulama ve karartma
- Arama, Türkçe ve İngilizce OCR, sıkıştırma ve düzenleme geçmişi
- Convert sekmesinde PDF → Word, metin veya PNG/JPEG ve Word veya PNG/JPEG → PDF

## Kaynak koddan çalıştırma

Python 3.10 veya üstünü kurun. Ardından `TugbayReader.cmd` dosyasına çift tıklayın. İlk çalıştırmada PDF motoru indirilir. Uygulama yerel tarayıcı sekmesinde açılır.

## Windows kurucusunu derleme

64 bit Windows üzerinde Python ve pip gerekir. PowerShell'de `./installer/Build.ps1` komutunu çalıştırın. Kurucu `build/TugbayReader-Kurulum.exe` konumuna yazılır.

Uygulama açılışta bu deponun GitHub Releases sayfasını kontrol eder. Yeni kararlı sürümde Windows kurucusu varsa kullanıcıya sürüm bağlantısını gösterir.

Kurulumdan sonra **Ayarlar → Uygulamalar → Varsayılan uygulamalar** ekranında `.pdf` uzantısını arayın ve **TugbayReader**'ı seçin. PDF dosyasına çift tıkladığınızda belge düzenleyicide açılır.

**Convert** sekmesinden açık PDF'yi veya yeni bir dosyayı dönüştürebilirsiniz. Word → PDF işlemi için Microsoft Word gerekir. PDF → Word çıktısında metin düzenlenebilir, taranmış sayfalar görsel olarak eklenir ve karmaşık yerleşimler değişebilir.

## Bağımlılıklar

- [PyMuPDF](https://pymupdf.readthedocs.io/en/latest/about.html) · AGPL veya ticari lisans
- [CPython](https://docs.python.org/3.13/license.html) · Python Software Foundation lisansı
- [Tesseract dil modelleri](https://github.com/tesseract-ocr/tessdata_fast/tree/4.1.0) · Apache 2.0

## Lisans ve kaynak kod

TugbayReader, [GNU Affero General Public License 3.0](LICENSE) ile dağıtılır.

Windows paketinin kaynak koduna ve PDF motorunun kaynak arşivine aynı [GitHub Releases](https://github.com/mertdmrc8/TugbayReader/releases) sayfasından erişebilirsiniz. Paket, PyMuPDF ve MuPDF 1.28.2 ile CPython 3.13.17 kullanır. Kurucuyu yeniden oluşturma komutu yukarıda verilmiştir.
