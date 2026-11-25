# Cấu hình và kiểm tra decoder trên AppWeb

## File thay đổi và cách chạy

- `AppWeb/index.html`, `AppWeb/styles.css`: menu nhãn/dropdown thẳng cột, thêm
  SPI CS/MISO/Mode và vùng thông báo. CSS/JS hiện dùng query version `2.0-workbench`.
- `AppWeb/analysis.js`: engine raw/incremental dùng chung capture/stream.
  `workbench.js`: cache/shared records, decoder lanes và bảng có bộ lọc;
  `app.js` giữ transport USB/controller, `analysis_worker.js` tính thống kê stream.
- `Tests/test_protocol_decoders.cjs`: waveform tổng hợp UART/I²C/SPI và kiểm tra
  bảng/overlay. `Tests/test_pc_stream_web.cjs`: bổ sung mock UI cho regression.
- `Tests/run_pc_stream_tests.ps1`: chạy thêm test decoder. `AppWeb/README.md`:
  cập nhật khả năng và giới hạn.

Chạy `AppWeb/run_web_app.bat`, mở localhost bằng Chrome/Edge và Ctrl+F5.
Query version là phiên bản tài nguyên Web, không phải phiên bản firmware.
Decoder không yêu cầu đổi `.ioc`, HAL, pin mapping hoặc USB protocol và không cần
nạp lại STM32 chỉ để cập nhật decoder. Riêng chẩn đoán OVERRUN chi tiết cần nạp
firmware 1.5, xem PC_STREAMING_GUIDE.md.

## Đo tín hiệu thực tế

Nối GND chung với thiết bị đo và đưa từng tín hiệu vào đầu vào D0–D7/PA0–PA7
phù hợp mức logic đầu vào hiện tại. Dropdown chọn **kênh đã nối dây**, không tự
đổi pin MCU hay phát tín hiệu lên bus. Mỗi tín hiệu của một protocol phải dùng
một kênh riêng; kênh có thể được dùng lại bởi decoder khác.

### UART

Chọn RX và baud đúng với đường tín hiệu; TX là kênh tùy chọn khác RX.
Menu UART format hỗ trợ5–9 data bits, None/Even/Odd parity,1/1.5/2 stop bits,
LSB/MSB first. Mặc định8-N-1 LSB; UART đảo mức chưa hỗ trợ.

- Xác nhận giữa start bit, lấy mẫu giữa data/stop bit.
- Cạnh start thực nằm giữa mẫu HIGH cuối và mẫu LOW đầu. Decoder dùng trung
  điểm khoảng này làm mốc timing, thay vì coi mẫu LOW đầu là cạnh chính xác.
  Ở 500 kSa/s, mốc ước lượng dịch sớm 1 µs, giảm thiên lệch lấy mẫu muộn khi
  tỷ số Fs/baud chỉ khoảng 4,34 (UART 115200). Đây là ước lượng, không khôi phục
  chính xác cạnh nằm giữa hai mẫu.
- Stop bit LOW khi đã có đủ mẫu: `FRAME ERROR` trên bảng và nhãn waveform.
- Stop bit HIGH: bảng ghi `STOP BIT OK`, không phải xác nhận toàn bộ data đúng.
  UART8-N-1 không có parity/CRC để phát hiện mọi bit dữ liệu sai. Nếu chọn parity,
  decoder thêm PARITY ERROR khi bit parity quan sát không đúng.
- Khi chưa xác định được ranh giới frame: thêm `UNSYNC · byte ước đoán` trên
  bảng, màu riêng và nhãn UNSYNC trên waveform; không coi byte đó đã đồng bộ.
- Thiếu mẫu data/stop ở cuối capture: báo `INCOMPLETE`, không tạo byte hợp lệ.
- Quét từ sau giữa stop bit để không bỏ qua start tiếp theo khi mẫu/bit không nguyên.
- Dưới 8 mẫu/bit: cảnh báo; dưới 3 mẫu/bit: không giải mã.

### Sai byte thỉnh thoảng ở stream 500 kSa/s

Với nguồn 115200 baud, chu kỳ mẫu 2 µs và mỗi bit dài khoảng 8,68 µs. Decoder
cũ dùng thời điểm mẫu LOW đầu làm cạnh start; kết hợp làm tròn vị trí lấy mẫu
và jitter TX có thể đẩy điểm đọc sát/sang bit kế tiếp. Stop bit vẫn có thể HIGH
nên dòng cũ `OK` dễ bị hiểu thành kiểm tra toàn bộ byte.

Mô phỏng 100 chuỗi, mỗi chuỗi gồm byte 0–255, với độ trễ từng bit TX giả lập
0–2 µs: decoder cũ xuất hiện lỗi ở 86 chuỗi, tổng 170 frame sai hoặc framing
error; bản mốc trung điểm không có lỗi trong bộ dữ liệu đó. Đây là regression
có kiểm soát, **không phải tỷ lệ lỗi đo trên board** và không chứng minh jitter
nguồn Sample thực tế luôn nằm trong khoảng này.

Source Sample hiện tạo UART bằng GPIO/DWT trong main loop cùng SPI/I²C; cần
CSV raw của lần sai để phân biệt jitter nguồn, nhiễu đường nối và sai đồng bộ.
Sửa timing không biến tín hiệu bị thiếu mẫu/nhiễu nặng thành dữ liệu chắc chắn đúng.
Để thử: Stop stream, Ctrl+F5, kết nối lại rồi giữ 500 kSa/s / 115200 baud.
So sánh toàn bộ chuỗi với `UART TEST 115200\r\n`. Chỉ cập nhật Web, không cần
nạp firmware STM32 cho thay đổi timing này. Nếu còn sai, Stop ngay và Export CSV
để giữ lại cửa sổ chứa byte sai trước khi bị rolling buffer ghi đè.

### Byte giả ở đầu capture / cửa sổ streaming

Capture hoặc rolling window có thể bắt đầu giữa data bit. Decoder không có lịch
sử trước mẫu đầu nên một cạnh HIGH→LOW của data có thể bị nhận thành start bit;
stop bit suy đoán vẫn có thể HIGH và sinh byte sai nhưng có STOP BIT OK.

Đã đọc `capture-12.csv` thực tế: D0 có idle HIGH 1,882 ms ở đầu, sau đó giải mã
được `55 41 52 54 20...`. Khi cắt lấy các mẫu 1520..5049 để mô phỏng cửa sổ bắt
đầu giữa byte, tái hiện chính xác `82,82,6A(FRAME ERROR),0A` ở đầu. Vì vậy CSV
gốc có idle và cửa sổ đã cắt phải được phân biệt khi đánh giá kết quả.

Web dùng khoảng HIGH liên tục ít nhất một frame (10bit với8-N-1) làm mốc đồng bộ mạnh: trong
một frame 8-N-1, HIGH liên tục tối đa là 8 data bit 1 + 1 stop bit. Đây **không
phải yêu cầu UART phải có khoảng nghỉ 10 bit**; chỉ là tiêu chí để xác nhận
ranh giới khi lịch sử đầu capture đã mất.

- Trước mốc này: vẫn hiển thị byte ước đoán với UNSYNC, kể cả stop bit HIGH.
- Sau mốc idle và cạnh start: hiển thị kết quả đã đồng bộ; payload vẫn cần kiểm
  tra theo protocol ứng dụng nếu muốn phát hiện lỗi data (STOP BIT OK không phải CRC).
- FRAME/PARITY ERROR làm mất trạng thái đồng bộ; chờ idle tiếp theo để xác nhận lại.
- UART back-to-back không có idle dài vẫn hiện kết quả ước đoán, không bị bỏ toàn
  bộ dữ liệu. Không tự chọn pha theo chuỗi ký tự biết trước hoặc giả định ASCII.

Ca regression rút gọn nằm trong `Tests/fixtures/uart_capture_boundary.json`:
chỉ lưu run-length D0, Fs=500k, 3530 mẫu; không phụ thuộc đường dẫn Downloads.
Kiểm thử xác nhận bốn byte đầu mang UNSYNC rồi khôi phục đủ chuỗi UART TEST ở
đoạn sau, đồng thời bảng và overlay sử dụng cùng trạng thái đồng bộ.

Streaming mới giữ FSM qua từng block, nên rolling window bỏ mẫu đầu không tự
làm UART mất đồng bộ. Phiên bắt đầu giữa byte, đổi decoder config, raw được
đọc lại từ file thiếu lịch sử hoặc data gap vẫn cần đồng bộ theo các quy tắc trên.

Để áp dụng: Stop stream, Ctrl+F5, kết nối lại. Không cần nạp firmware STM32.

### I²C

Chọn SCL và SDA. START/STOP chỉ nhận khi SDA đổi trong lúc SCL HIGH ở cả mẫu
trước và sau. Nếu SCL/SDA đổi cùng mẫu ở cạnh lên, dừng giải mã đoạn chưa chắc
chắn và chờ START tiếp theo, thay vì nhận nhầm START/STOP.

Hỗ trợ START, repeated START, địa chỉ 7 bit, R/W, data, ACK/NACK, STOP.
Ví dụ byte thô `0xA0` hiện thêm `Address 0x50 · Write · ACK`; `0xA1` là Read.
Xung SCL chuẩn bị STOP/repeated START không bị tính là byte dữ liệu thiếu.
Địa chỉ 10 bit được nhận diện và báo `UNSUPPORTED`, không diễn giải payload.

Nếu capture bắt đầu giữa giao dịch: chờ START thực; không tự suy đoán byte địa
chỉ. Capture cũ với pre-trigger 0% có thể thiếu START, cần thu lại với pre-trigger.
Cuối capture chưa có STOP hoặc byte bị cắt được báo `INCOMPLETE`.

### SPI

Bắt buộc chọn đủ bốn kênh khác nhau:

| Tín hiệu | Mặc định | Ý nghĩa |
|---|---|---|
| CS (LOW) | D2 / PA2 | Chỉ giải mã khi CS LOW |
| SCK | D0 / PA0 | Clock của bus cần đo |
| MOSI | D1 / PA1 | Dữ liệu controller gửi tới peripheral |
| MISO | D3 / PA3 | Dữ liệu peripheral trả lại controller |

Có thể chọn D0–D7 theo dây nối thực tế. Các chân PB13/PB15 của bộ phát self-test
không phải chân bắt buộc khi đo bus ngoài.

| Mode | CPOL | CPHA | SCK nghỉ | Cạnh đọc |
|---:|---:|---:|---|---|
| 0 (mặc định) | 0 | 0 | LOW | Lên |
| 1 | 0 | 1 | LOW | Xuống |
| 2 | 1 | 0 | HIGH | Xuống |
| 3 | 1 | 1 | HIGH | Lên |

Chọn Mode theo cấu hình hai thiết bị trên bus; không tự đoán Mode.
Menu Word format hỗ trợ1–32bit/word, MSB/LSB và CS active LOW/HIGH.
Các mô tả LOW/tám bit dưới đây là cấu hình mặc định; cấu hình khác áp dụng tương
đương theo polarity/word size đã chọn.

- CS xuống LOW: reset bộ đếm bit và mở giao dịch; mỗi byte đọc cả MOSI/MISO.
- Clock khi CS HIGH bị bỏ qua; không ghép bit qua hai lần CS.
- CS lên khi chưa đủ tám bit: giữ byte hoàn chỉnh trước đó, báo byte cuối thiếu.
- CS đã LOW ở mẫu đầu: bỏ đoạn chưa đồng bộ, chờ CS lên rồi xuống tiếp.
- CS còn LOW cuối capture: byte đủ tám bit từ đầu giao dịch đã đồng bộ vẫn
  hiển thị với `CAPTURE END`; byte chưa đủ không được xuất.
- CS/SCK đổi cùng mẫu, SCK sai mức nghỉ lúc mở giao dịch, hoặc data đổi cùng mẫu
  với cạnh đọc: báo `TIMING` và loại kết quả của giao dịch đó.
- Dưới bốn mẫu giữa hai cạnh SCK liên tiếp: cảnh báo nên tăng sample rate.
  Không thể sửa lỗi aliasing hoặc khôi phục cạnh vốn không được thu vào buffer.

Decoded Data hiện MOSI/MISO cùng hàng; chọn Data/Frames/Transactions trong một
khu vực thống nhất. Không còn tab Protocol Analyzer lặp hoặc overlay trên raw.
SPI lane riêng hiển thị word, transaction, lỗi và bit MOSI/MISO theo cặp khi mở.
Thời gian word bắt đầu tại sample đọc bit đầu; end là sample đọc bit cuối.
UART end là điểm stop bit cuối được kiểm tra, không phải timestamp cạnh thực
chưa được quan sát. Không suy diễn độ chính xác vượt Fs.

Lanes/table dùng cùng record ID và timeline. Bộ lọc, format, export, retention,
session và các ca kiểm thử mới xem [AppWeb/README.md](../AppWeb/README.md).

Bộ phát SPI self-test cũ chỉ tạo SCK/MOSI; không được mở rộng ở lần sửa này và
không đủ để kiểm thử decoder bốn chân. Việc sửa decoder không chứng minh bus
thực tế đã được giải mã đúng khi chưa kiểm tra dữ liệu tham chiếu từ thiết bị.

## Kiểm thử

Với Node.js, chạy tại thư mục project:

```powershell
node Tests/test_protocol_decoders.cjs
node Tests/test_pc_stream_web.cjs
```

Hoặc `Tests/run_pc_stream_tests.ps1` để chạy cả các regression C hiện có.

Đã qua các ca mô phỏng:

- SPI Mode 0–3, mọi giá trị byte 0–255, MOSI/MISO khác nhau, nhiều giao dịch,
  đổi kênh, CS HIGH, CS ngắt byte, capture cắt đầu/cuối và cạnh không rõ thứ tự.
- UART chuỗi byte liên tiếp, glitch, framing error, dữ liệu bị cắt, mức tĩnh,
  đổi kênh, tỷ số sample/baud thấp và 1 MHz / 115200 baud không nguyên mẫu/bit.
- UART 500 kSa/s và 1 MSa/s: quét 100 pha lấy mẫu cho mọi giá trị byte 0–255;
  thêm 100 seed jitter TX 0–2 µs tại 500 kSa/s để kiểm tra sửa mốc cạnh start.
- Trace UART thực bị cắt giữa byte: gắn UNSYNC, không khẳng định byte giả đã
  hợp lệ; khôi phục đồng bộ sau idle và giữ khả năng hiển thị UART back-to-back.
- I²C địa chỉ 7 bit Read/Write, ACK/NACK, repeated START, STOP, SCL/SDA đổi
  cùng mẫu, giao dịch bị cắt và nhận diện địa chỉ 10 bit chưa hỗ trợ.
- Bảng/overlay trùng kênh, giá trị và chỉ số mẫu; cache đổi khi snapshot hoặc
  cấu hình đổi; regression parser/ring/continuity và scheduler stream 20 Hz.

Chưa xác nhận trực quan trong Chrome: công cụ Computer Use dừng vì không xác định
chắc URL hiện tại. Cần kiểm tra menu ở sidebar 215–252 px và theme sáng/tối,
bao gồm độ rộng dropdown baud, bốn kênh SPI và cuộn panel.
Chưa đo bus ngoài trên phần cứng để nghiệm thu decoder mới.
