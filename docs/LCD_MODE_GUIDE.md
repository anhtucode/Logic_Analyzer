# LCD hardware scroll ILI9341 — phát lại chậm

## Sử dụng và bố cục

- PB5 hở rồi reset: PC mode. PB5 xuống GND rồi reset: LCD mode.
- PB6 Start thu 4096 mẫu ở 500 kSa/s (8,192 ms), sau đó dừng DMA và phát lại.
- PB7 Stop giữ hình. Nếu đang ghi cột mới, hoàn tất bước hiện tại rồi HOLD.
- Start lúc REC/PLAY hoặc đang hoàn tất bước Stop: bỏ qua. Khi HOLD, Start thu lại.

Sidebar cố định x=0..63; waveform cuộn x=64..319, y=0..239.
Tám kênh có lane cao 30 pixel. Thông số ở x=2..43, nằm trước các nhãn
D0–D7 tại x=48..59, rồi tới waveform ở x=64.
Các thông số còn hiển thị: Fs 500K SA/S, FPS đo được, số mẫu 4096,
START/PB6, STOP/PB7 và trạng thái REC/PLAY/IDLE/ERROR khi phù hợp.
Đã bỏ SPAN, SLOW và chữ HOLD khỏi giao diện. Khi phát hết/Stop, vẫn giữ hình
như trước nhưng để trống ô trạng thái thay vì ghi HOLD. Cửa sổ vẫn là 2 ms.
Thời điểm cửa sổ vẫn được theo dõi nội bộ, không hiển thị số thời gian hoặc US.

Giữ cửa sổ khoảng 2 ms trên 256 pixel: 7,8125 µs/pixel.
Xung 1 kHz có khoảng 2 chu kỳ/màn hình; xung 10 kHz có khoảng 20 chu kỳ.
Đây là phát lại chậm một đoạn đã thu, không phải live streaming.

## Cách dịch nguyên khối waveform

Giữ MADCTL=0x28 (landscape, MV=1). Lệnh VSCRDEF 0x33 đặt:
fixed 64 + scroll 256 + fixed 0 = 320 theo trục native của ILI9341.
Trong landscape, vùng cuộn này tương ứng vùng bên phải sidebar.

Vẽ cửa sổ đầu một lần. Mỗi 100 ms, chuẩn bị tối đa 3 cột mới:
1. Tính các cột kế tiếp từ raw recording trên cùng một lưới thời gian tuyệt đối.
2. Ghi ba cột vào vị trí GRAM của ba cột cũ nhất, chia mỗi cột 240 pixel thành
   4 lần gửi tối đa 128 byte (64+64+64+48 pixel).
3. Chỉ khi ghi đủ và không có lỗi SPI, gửi VSCRSADD 0x37 để đổi địa chỉ đầu vùng
   cuộn. Cả 8 waveform dịch trái cùng một bước, không vẽ lại phần ảnh cũ.

Địa chỉ hiển thị là 64 + head, head chạy vòng 0..255.
Sau lần vẽ đầu, một bước thông thường gửi 1440 byte pixel waveform,
thay vì 122880 byte cho toàn vùng 256x240. Sidebar chỉ cập nhật ô chữ thay đổi.
Vạch thời gian cuộn cùng dữ liệu, vạch ngang lane giữ cùng vị trí Y.

Cột k chứa các mẫu ceil(k*1000/256)..ceil((k+1)*1000/256)-1.
LOW-seen/HIGH-seen và cạnh qua biên cột được tính từ raw, không gom lại toàn
cửa sổ sau mỗi bước. Mỗi bước 3 pixel tương đương khoảng 23,44 µs dữ liệu.
Ở 10 bước/s, chuyển động chậm khoảng 4267 lần thực tế.

Không nối cuối bản ghi về đầu. Chỉ vẽ cột đủ dữ liệu: 4096 mẫu có 1048 cột
đầy đủ, giữ lại 2 mẫu cuối trong raw nhưng không vẽ thành cột chưa đủ.
Vị trí cuối là cột 792, T=6188 µs, sau khoảng 26,4 giây ở 10 bước/s rồi HOLD.
Chỉnh LCD_SCROLL_STEP_PIXELS để đổi tốc độ cuộn; bước lớn có thể gây hiệu ứng
xung tuần hoàn trông đứng yên/chạy ngược. SPAN phải vừa recording (tối đa 8 ms).

Đây không phải double framebuffer hoặc cam kết không tearing tuyệt đối.
Trước khi đổi pointer, vài cột ở mép trái có thể đổi trong thời gian ghi dải mới.
Hướng cuộn và vùng cố định phải xác nhận trên module thật.
Không tắt/bật display giữa các bước, không cần thay dây hoặc thêm DMA SPI.

## Nguồn, khởi tạo và lỗi

Đấu dây theo HARDWARE_PIN_CONFIGURATION.md. Boot thử RGB ở SPI 2,25 MHz,
sau đó khôi phục SPI2 18 MHz. LCD_BOOT_COLOR_TEST=0 để bỏ phép thử màu.
Giữ controller ở Normal Mode; không dùng Partial Mode với hardware scroll.
Nếu chỉ đèn nền sáng, kiểm tra PB5/GND/reset, nguồn/J1 và các dây SPI/control.

DMA/OVERRUN: Stop rồi Start. SPI lỗi: không commit pointer mới, dừng phiên;
kiểm tra dây/nguồn rồi reset. HAL gửi thành công không chứng minh LCD đã nhận đúng.
Debugger: lcd_init_stage, spi_failed, draw_mode, scroll_head, left_column,
pending_head/pending_left, workspace.lcd.recorded_samples/playback_offset,
frame_render_ms, fps (đơn vị 0,1 FPS).

## Build và kiểm thử

1. Keil: mở MDK-ARM/Logic_Analyzer.uvprojx, Rebuild target Logic_Analyzer.
2. Kiểm tra 0 lỗi/cảnh báo, RW_IRAM1 <= 0x5000 (đã gồm stack/heap reserve).
3. Nạp, nối PB5 xuống GND rồi reset. Sidebar phải đứng yên, waveform bên phải.
4. Đưa xung 1–10 kHz vào PA0, chung GND. Start: REC → PLAY, quan sát dịch trái.
5. Chạy hết ít nhất 3 vòng GRAM; kiểm tra không có đường nối giả tại điểm wrap.
6. Kiểm tra Stop giữa bước, giữ nút, hai nút cùng lúc, Start thu lại và HOLD cuối.
7. Đo FPS thực tế. Sai hướng cuộn/sidebar bị kéo theo phải được xử lý ánh xạ
   controller trước khi coi hoàn tất; host test không chứng minh chiều scan vật lý.
8. PC mode: kiểm tra capture/trigger và streaming USB 1/5/10 kSa/s vẫn hoạt động.

Host test, PowerShell tại gốc project:

~~~powershell
gcc -std=c99 -O2 -flto -Wall -Wextra -Werror -Wno-pointer-to-int-cast -Wno-int-to-pointer-cast -ffunction-sections -fdata-sections -DUSE_HAL_DRIVER -DSTM32F103xB -ICore/Inc -IDrivers/STM32F1xx_HAL_Driver/Inc -IDrivers/CMSIS/Device/ST/STM32F1xx/Include -IDrivers/CMSIS/Include Tests/test_lcd_stream.c Core/Src/lcd_mode.c '-Wl,--gc-sections' -o "$env:TEMP\test_lcd_mode.exe"
& "$env:TEMP\test_lcd_mode.exe"
~~~

Đổi file test/executable sang test_lcd_init để chạy mô phỏng GRAM.
- test_lcd_stream: raw bounds/canary, lưới cột theo reference độc lập, cạnh,
  đọc đủ cột, loại cột đuôi chưa đủ, 1/10 kHz và giới hạn workspace.
- test_lcd_init: decode SPI/GRAM, tham số 0x33/0x37, dữ liệu trước pointer,
  pixel của đủ 8 kênh qua hơn 3 vòng, sidebar, Stop, cuối bản ghi, SPI fault.
Không thay thế phép đo tốc độ/tín hiệu trên board.

## Bộ nhớ

Recording 4096 byte và pixel scratch 128 byte nằm trong workspace union
8192 byte của acquisition. Không còn hai frame masks/cache cạnh.
PC vẫn dùng cùng union làm capture buffer 8192 byte; DMA buffer 2048 byte riêng.
USB/HAL vẫn có biến tĩnh trong binary, không cấp phát heap cho LCD.

Tham khảo: [ILI9341, mục 8.2.26 và 8.2.30](https://cdn-shop.adafruit.com/datasheets/ILI9341.pdf).
