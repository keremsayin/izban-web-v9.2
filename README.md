# İZBAN Web v8

- Harita: Yalnızca OSM'deki İZBAN `route=train` ilişkilerinin ana ray geometrileri çizilir; istasyonlar arası yapay düz çizgi kullanılmaz.
- Fallback: OSM ana ray grafiği, ardından resmi GTFS `shapes.txt`.
- Kuzey yönü: Aliağa tarafı. Güney yönü: Tepeköy/Selçuk tarafı.
- Nereden → Nereye: trenin gerçek son durağı öncelikle GTFS `stop_times` son durağından alınır; seçilen varış istasyonuyla aynı diye ezilmez.
- Harita istasyon seferleri: `stationFinal` hatası düzeltildi; kısa Alsancak → Gaziemir seferleri de GTFS'ten alınabilir.
- Legacy fallback final adaylarına Gaziemir eklendi.
