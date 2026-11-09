# ETVIEW Logic Analyzer Web

Dashboard local được thiết kế theo ảnh `Logic Analyzer Waveform Dashboard.png`.
Ứng dụng dùng Web Serial API để giao tiếp trực tiếp với STM32 USB CDC; dữ liệu
không đi qua server và không được tải lên Internet.

## Chạy

```powershell
cd AppWeb
.\\run_web_app.bat
```

Hoặc:

```powershell
python -m http.server 8080 --bind 127.0.0.1
```

Sau đó mở `http://localhost:8080` bằng Chrome hoặc Edge. Firefox hiện không
hỗ trợ Web Serial.

## Luồng điều khiển

1. Nhấn **Kết nối** và chọn cổng STM32 Virtual COM.
2. Chọn mode Capture hoặc Streaming.
3. Chọn sample rate và cấu hình trigger.
4. Nhấn **Start**.
5. Web gửi `SET_CONFIG` bằng binary packet có CRC16-CCITT.
6. Sau ACK, web gửi `ARM` cho Snapshot hoặc `START_STREAM` cho Streaming.
7. Web poll `GET_STATUS`; khi COMPLETE, dữ liệu được đọc bằng các chunk
   `GET_DATA` tối đa 512 mẫu.
8. **Stop** gửi `STOP` hoặc `STOP_STREAM` tùy mode.

Khi chưa kết nối hoặc chưa capture, dashboard để waveform trống và không tự
tạo dữ liệu demo. Giao thức chi tiết nằm trong `../PC_PROTOCOL.md`.

## Chức năng

- Waveform 8 kênh trên Canvas, tự co giãn theo kích thước cửa sổ.
- Zoom bằng nút hoặc con lăn chuột; nút **✥** để kéo waveform theo trục thời
  gian. Có thể giữ `Shift` hoặc dùng chuột giữa/phải để kéo nhanh.
- Hai cursor A/B đo thời gian, Δt và 1/Δt. Nhấn nhãn **A** hoặc **B** ở chân
  waveform để chọn cursor đang điều khiển.
- **Snap** tự căn cursor vào cạnh gần nhất của kênh đang chọn. Chọn Rising,
  Falling hoặc Any rồi dùng **‹ / ›** để đi đến cạnh trước/sau.
- Di chuột trên mức HIGH/LOW để xem logic level, thời điểm và pulse width.
- Cột A/B trong danh sách Channels hiển thị mức logic 0/1 của cả 8 kênh tại
  hai cursor.
- Trigger rising/falling và pre-trigger 25/50/75%.
- Capture 8192 mẫu và streaming rolling window.
- Thống kê frequency, period, duty cycle, HIGH width và LOW width.
- Decoder UART 8-N-1, I²C cơ bản và SPI mode 0. Kết quả được gắn nhãn trực
  tiếp trên waveform; nhấn một hàng đã giải mã để đưa cursor đến sự kiện đó.
- Tab Decoded Data gộp và sắp xếp theo thời gian các sự kiện UART, I²C và SPI;
  Protocol Analyzer vẫn giữ bảng chi tiết riêng cho từng protocol.
- Save/Load capture JSON, Export CSV, event log và light/dark theme.
- Self Test điều khiển trực tiếp từ web: tự chọn 100 kSa/s cho UART, 10 kSa/s
  cho I²C hoặc 500 kSa/s cho SPI, ARM trước rồi mới phát mẫu từ chính STM32.
- Self Test dùng pre-trigger 1% để giữ lại mức idle trước start bit/START. Decoder
  I²C vẫn nhận được capture cũ bắt đầu ngay tại START và đánh dấu `CAPTURE BOUNDARY`.
- Decoder UART xác nhận mức giữa start bit để loại xung nhiễu ngắn và byte giả.

Phần Trigger nằm ngay dưới Acquisition. `Position` thuộc Trigger và xác định
tỷ lệ dữ liệu nằm trước thời điểm trigger. Channel Legend đã được bỏ vì màu và
tên kênh đã hiển thị trực tiếp trên waveform và danh sách Channels.

Kết quả build hoặc chạy dashboard không chứng minh khả năng lấy mẫu 1 MHz trên
phần cứng. Cần kiểm thử với STM32 và nguồn tín hiệu thực tế.

## Self Test không cần thiết bị ngoài

Nạp firmware 1.3 mới, kết nối USB CDC và đấu dây theo protocol muốn thử:

| Self Test | Dây loopback |
|---|---|
| UART | PA9 → PA0/D0 |
| I²C | PB10 → PA0/D0, PB11 → PA1/D1 |
| SPI | PB13 → PA0/D0, PB15 → PA1/D1 |

Tháo dây PB0 khỏi PA0 trước khi chạy protocol self-test. Trong mục **Self
Test**, chọn protocol, chọn One Shot hoặc Repeat rồi nhấn **Run Test**. Web tự
chọn sample rate, trigger và decoder. **Stop Test** chỉ dừng bộ phát; nút Stop
trên thanh công cụ dừng cả bộ phát và acquisition.
