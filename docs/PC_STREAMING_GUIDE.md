# PC streaming 1–500 kSa/s — firmware 1.5

## Các phần đã thay đổi

| File | Chức năng thay đổi |
|---|---|
| `Core/Inc/acquisition.h` | Queue 8 block và flags phân loại QUEUE_FULL / DMA_LATE |
| `Core/Src/acquisition.c` | FIFO dùng chung workspace; kiểm tra DMA trước/sau copy, đánh dấu đúng nguyên nhân lỗi |
| `Core/Src/pc_interface.c` | CRC lookup table trong Flash; consume queue sau BuildFrame; INFO 1.5 |
| `AppWeb/app.js` | Bộ đệm Web Serial 1 MiB, nhận dạng lỗi chi tiết, log ACK đúng trạng thái MCU, giữ lỗi phiên trên UI |
| `Tests/test_pc_stream.c` | Mô phỏng source firmware hiện dùng, USB và thanh ghi HAL |
| `Tests/test_pc_stream_web.cjs` | Mô phỏng parser, ring, lifecycle và scheduler AppWeb |
| `Tests/run_pc_stream_tests.ps1` | Chạy host test firmware/Web và regression LCD |

Tài liệu cập nhật: `PC_PROTOCOL.md`, `FIRMWARE_README.md`, `USB_CDC_GUIDE.md`,
`AppWeb/README.md`, `docs/architecture.md` và file này. Không thêm source firmware,
nên Keil project không cần thêm file. Giữ nguyên pin mapping, vùng CubeMX tự sinh,
LCD mode và thuật toán capture.

## Bộ nhớ và luồng dữ liệu

```text
TIM2_UP -> GPIOA_IDR -> DMA circular 2048 byte
                            | half/full 1024 byte
                            v
                    FIFO 8 x 1024 byte
                            | copy + CRC
                            v
                    TX frame 1049 byte
                            | USB CDC bulk packets <=64 byte
                            v
                 AppWeb parser -> rolling ring 8192
                            | tối đa 20 lần/giây
                            v
                     đo, decode và waveform
```

FIFO nằm trong union với capture 8192 byte và workspace LCD. Chỉ một mode dùng
vùng này mỗi thời điểm, không tăng SRAM thêm 8 KiB. DMA staging và TX buffer là
các vùng riêng; USB giữ TX buffer đến TxState=0. CRC-16/CCITT-FALSE không đổi.

Keil ArmClang V6.24: 0 error, 0 warning; RW=400, ZI=18416, tổng RAM=18816 byte,
còn 1664 byte chưa phân bổ trong 20 KiB. ZI đã gồm reserve stack/heap; chưa đo
stack high-water trên board. Map xác nhận bảng CRC 512 byte nằm ở Flash.

AppWeb nhận/kiểm tra mỗi block, nhưng bỏ mẫu cũ ngoài cửa sổ 8192 mẫu khi hiển thị.
Đây không phải mất packet truyền. Save/Export chỉ lưu cửa sổ hiện tại, không ghi
toàn phiên. Decoder ở ranh giới cửa sổ có thể thiếu frame.

## Cấu hình cần kiểm tra

- PB5 HIGH/hở tại reset: PC mode. USB CDC đã enumerate trước khi Start.
- TIM2 clock 72 MHz: PSC=0, ARR tương ứng 50k=1439, 100k=719, 500k=143.
- DMA1 Channel2, TIM2_UP, circular, peripheral half-word, memory byte/increment,
  very high priority, half/full/error interrupt; NVIC DMA priority 0, USB priority 2.
- PA0..PA7 input như hiện tại; USB PA11/PA12, clock 48 MHz.
- Không đổi `.ioc` cho chức năng này. Stream 1 MSa/s bị từ chối; capture vẫn có.

## Build/debug Keil và chạy Web

1. Mở `MDK-ARM/Logic_Analyzer.uvprojx`, target Logic_Analyzer, **Rebuild all**.
2. Kiểm tra build log và RAM/Flash trong `.map`; nạp bằng ST-Link.
3. Reset ở PC mode. Chạy `AppWeb/run_web_app.bat`, Chrome/Edge, Ctrl+F5.
4. Kết nối COM, xác nhận INFO firmware 1.5; chọn Streaming và sample rate.
5. Start phải ACK SET_CONFIG rồi ACK START_STREAM: STREAMING, tiếp đến STREAM #id.
6. Stop phải ACK STOP_STREAM: IDLE; Start lại có first_sample=0, stream_id mới.

Nếu lỗi: xem `status.error`, `status.flags`, `status.dropped_blocks`, occupancy
`stream_queue_write - stream_queue_read`, và `produced_blocks - processed_blocks`.
Breakpoint lâu khi DMA chạy có thể tự gây OVERRUN.

## OVERRUN thỉnh thoảng ở 500 kSa/s

Log cũ `flags=0x0001, dropped_blocks=1` cho biết phiên bị dừng ở lần phát hiện
overrun đầu tiên. Nó không đủ để kết luận USB, trình duyệt hay main loop gây ra
lỗi; cũng không phải phép đếm chính xác mọi block/mẫu đã mất trên đường truyền.

Firmware 1.5 bổ sung nguyên nhân trong cùng STATUS/frame hiện có:

| Flags | Nguyên nhân | Kiểm tra tiếp |
|---|---|---|
| `0x0005` | QUEUE_FULL: 8 block chưa được rút kịp | So sánh bật/tắt decoder, tải PC, cáp/hub USB và thời gian CDC TxState BUSY |
| `0x0009` | DMA_LATE: block DMA xử lý quá trễ | Kiểm tra main loop, IRQ/critical section, breakpoint; thêm queue không sửa được deadline này |
| `0x0001` | Firmware cũ chưa phân loại | Nạp 1.5 và lấy log mới |

Ở 500k, mỗi nửa DMA hoàn tất trong 2,048 ms; queue 8 KiB tương đương 16,384 ms
dữ liệu. Tốc độ frame cần ~512207 byte/s. Một lần trễ ngắn vẫn có thể gây dừng
dù trước đó chạy bình thường nhiều giây; không tự kết luận thiếu throughput trung bình.

Web xin bộ đệm Web Serial **1 MiB thay cho 16 KiB**, giữ parser 64 KiB và rolling
window 8192 mẫu. Dự trữ phía PC lớn hơn có thể giảm backpressure khi JavaScript
tạm bận render/GC; không tăng SRAM STM32 hay thông lượng USB. API cho phép cấu
hình bufferSize, xem [Chrome Web Serial](https://developer.chrome.com/docs/capabilities/serial).
Thay đổi này cần đóng/kết nối lại COM vì buffer được tạo lúc port.open().

Log ACK in trạng thái MCU trả về, ví dụ `ACK STOP_STREAM: IDLE · Web giữ ERROR
của phiên trước`. UI vẫn giữ ERROR để người dùng biết phiên vừa rồi bị gián đoạn.
TX được log trước khi chờ writer.write() hoàn tất, tránh ACK xuất hiện trước TX
khi thiết bị phản hồi rất nhanh. Không tự retry/restart stream lỗi để che mất mẫu.

Kiểm tra lại: nạp 1.5, Ctrl+F5, kết nối lại COM, stream 500k ít nhất 10 phút ở
hai điều kiện: tắt toàn bộ decoder, rồi bật các decoder như lúc gặp lỗi. Gửi log
QUEUE_FULL/DMA_LATE nếu còn xảy ra. Bản sửa đã qua host test/build; chưa có kết
quả stress board để khẳng định đã hết OVERRUN.

## Kết quả host test và giới hạn

Chạy từ PowerShell với GCC và Node.js trong PATH:

```powershell
.\Tests\run_pc_stream_tests.ps1
```

`-SkipWeb` chỉ chạy các test C; test Web chạy riêng bằng
`node Tests/test_pc_stream_web.cjs`. Binary C nằm trong thư mục TEMP.

Đã qua: sáu rate stream, từ chối stream 1M, CRC so với bitwise/reference,
FIFO đầy/wrap/thứ tự, sample index wrap 32 bit, DMA trễ/ghi đè khi copy, USB BUSY
và TX lifetime, Stop/reconnect; capture 8192 có/không trigger; regression LCD.
Web: mọi điểm cắt frame 1049 byte, burst lớn hơn parser, CRC/gap/duplicate/ID,
sequence wrap 8 bit, sample index wrap, ring 8192, giới hạn 20 Hz/một RAF,
sticky ERROR/Start mới/Stop/disconnect và polling lỗi khi stream.

Benchmark mô phỏng parser/ring trên máy phát triển đạt khoảng 25 MB/s cho
512000 mẫu; **không gồm USB, DOM, canvas hoặc decoder thực tế**. Không dùng số
này để kết luận board chạy được 500 kSa/s.

## Stress test trên board — chưa thực hiện

| Rate | Block interval | STREAM frame bytes/s | Cửa sổ 8192 mẫu |
|---:|---:|---:|---:|
| 1 kSa/s | 1024 ms | 1024 | 8,192 s |
| 5 kSa/s | 204,8 ms | 5122 | 1,6384 s |
| 10 kSa/s | 102,4 ms | 10244 | 819,2 ms |
| 50 kSa/s | 20,48 ms | 51221 | 163,84 ms |
| 100 kSa/s | 10,24 ms | 102441 | 81,92 ms |
| 500 kSa/s | 2,048 ms | 512207 | 16,384 ms |

1. Nối PB0 (100 Hz) -> PA0/D0, GND chung. Tháo loopback protocol self-test.
2. Chạy **ít nhất 10 phút ở từng rate**, từ thấp lên cao. Bật lần lượt decoder
   để đánh giá tải PC, và thử zoom/pan/đổi tab trong khi nhận.
3. Pass khi không thiếu sequence/index/CRC, `dropped_blocks=0`, không ERROR,
   occupancy không tăng liên tục; D0 khoảng 100 Hz với sai số lượng tử mẫu.
4. Đo byte nhận thực tế/giây trên USB/PC. 500k cần >=512207 byte/s frame liên tục;
   mục tiêu >=625000 byte/s khả dụng để có dư địa (~22%, chưa tính overhead USB).
5. Làm chậm PC/tạm dừng nhận có kiểm soát để đầy FIFO: phải dừng với OVERRUN,
   không nối waveform qua vùng thiếu mẫu. Start mới phải phục hồi.
6. Thử Stop/Start liên tục, rút/cắm USB, kết nối lại. Sau lỗi nạp/tạm dừng CPU,
   reset board nếu USB stack không phục hồi. Kiểm tra capture có/không trigger,
   LCD boot/Start/Stop và hardware scroll vẫn như trước.

Ghi kết quả board/cáp USB/PC/browser, rate, thời gian, throughput và lỗi.
Nếu 500k không đạt, dùng 100k/50k và phân tích bottleneck trước khi nâng tốc độ;
FIFO chỉ hấp thụ jitter ngắn, không bù throughput thiếu kéo dài.
