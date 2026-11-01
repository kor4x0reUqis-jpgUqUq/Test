# UqBOAT 1.5.6.1 — çevrimdışı skill paketi

Bu paket, gönderdiğiniz UqBOAT 1.5.6 kaynaklarına dayanır. Chrome uzantısı ve yerel köprü bir aradadır. Ayrıntılı ve dürüst test sınırları için `TEST_RAPORU.md` dosyasını okuyun.

## Windows / Chrome kurulumu
1. **ZIP'i önce tamamen çıkarın.** `start.bat` dosyasını ZIP'in içinden çalıştırmayın.
2. Chrome'da `chrome://extensions` sayfasını açın. Eski UqBOAT kopyasını karışıklık olmaması için geçici olarak **kapatın** (silmek zorunda değilsiniz).
3. Sağ üstten **Geliştirici modu**nu açın. **Paketlenmemiş öğe yükle**'ye tıklayın.
4. Çıkarılan klasörün içindeki **`uqboat-extension`** klasörünü seçin. Seçtiğiniz klasörün içinde `manifest.json` olmalı.
5. Roblox Studio'da place açın ve Assistant > … > Manage MCP Servers > Enable Studio as MCP Server ayarını açın.
6. Çıkarılan ana klasörde `start.bat` dosyasını çalıştırın, açık tutun. macOS'ta `MacOS_Start.command` kullanın. İlgili sohbet sitesini yenileyin; UqBOAT çubuğundan oturumu başlatın.
7. Arena Agent veya Direct kullanın. Testlerinizi yeni, yedeklenmiş bir place üzerinde yapmanız önerilir.

Yeni uzantı Chrome tarafından eski kopyadan ayrı bir uzantı gibi görülebilir; eski kopyanın ayarları otomatik taşınmayabilir. Yalnızca bu ZIP'i Chrome'a sürüklemek yeterli değildir: önce çıkarıp klasörü seçmek gerekir.

## Skill'ler ve erişim
`uqboat-extension/skills/` içinde üç paket yer alır:
- `modelmaker/sonskills/`: `ModelMakerSkills.zip` dosyasının tüm içeriği.
- `referans_studio/sonskills/`: `ModelMakerSkills_4.1_ReferansStudio.zip` dosyasının tüm içeriği.
- `stud_ui/`: `Stud-UI-Clean-Roblox` deposunun Git dışındaki tüm dosyaları; `src/StudUI.luau`, `src/StudMotion.luau`, `src/CheckUIIcons.luau`, örnekler ve kaynak görseller dahil.

İki orijinal ZIP ayrıca `Orijinal_Skill_ZIPleri/` klasöründe korunur. Asistanın başlangıç talimatına, modelleme ve Roblox UI görevlerinde bu yerel skill'leri kullanması eklendi. `list_offline_skills` ve `read_offline_skill` uzantı içi, **salt okunur** komutlardır; Studio MCP veya GitHub gerektirmez. Uzun metinler `nextOffset` ile parça parça okunur. PNG/JPEG referanslar görüntü destekleyen sağlayıcılara eklenmeyi dener; bu, sohbet sitesinin görsel yükleme/limit koşullarına bağlıdır. Diğer ikili dosyalar klasörde bulunur ancak metin komutuyla okunmaz.

Önemli: Skill'lerin uzantıda olması modüllerin otomatik olarak Roblox projesine kurulduğu anlamına gelmez. AI, yerel kaynakları okuyup Studio komutlarıyla kurulumu yapmalıdır. Roblox görsel/ses asset ID'lerinin çalışması ayrıca Roblox'a ve izinlerine bağlıdır. AI sitesi hâlâ internet gerektirir; Windows başlatıcısı Python/dependency eksikse bunları kurmak için internet isteyebilir. 'Çevrimdışı' yalnızca skill kaynağı için geçerlidir.

## Direct ve Agent
Arena **Direct** modunda `list_commands` sırasında otomatik proje ağacı snapshot çağrısı kaldırıldı; gerçek iş için gerektiğinde proje okunabilir. Yanıt bittikten sonraki bekleme 500 ms'den 300 ms'ye indirildi. Eksik komutları engelleyen streaming kontrolleri korunur. Bu değişiklikler AI modelinin üretim hızını veya Studio gecikmesini değiştirmez; gerçek koşullarda ne kadar hız kazandırdığı henüz ölçülmemiştir.

Arena **Agent** modunun var olan snapshot, zamanlama, komut yönlendirme ve genel akışı bilerek korunmuştur. Yeni yerel skill komutları ve skill kullanım talimatları iki modda da eklendiğinden prompt/komut listesi değişmiştir. Canlı Agent regresyon testi yapılmadı.

## Kaynaklar ve lisans
- Kullanıcının UqBOAT kaynak ve skill deposu: https://github.com/kor4x0reUqis-jpgUqUq/Test — commit `995fbc7`.
- Stud UI: https://github.com/TemporaryLooker22/Stud-UI-Clean-Roblox — commit `7ae67f3f4cf4bd55a597d8f58d81feebb1be7dee`; MIT lisans dosyası ve üçüncü taraf bildirimleri kendi klasöründedir.
- UqBOAT'ın GPL-3.0-or-later lisansı ana klasördeki `LICENSE` dosyasındadır. Kaynak kodları pakete dahildir.
