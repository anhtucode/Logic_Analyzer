# ETVIEW Logic Analyzer Web

## Audit cải tiến Web — 24/11/2026 (trước triển khai)

Đã đọc app.js, index.html, styles.css, PC_PROTOCOL.md, tài liệu firmware/kiến
trúc và các test hiện có. Không có Git repository tại workspace; đã lưu bản
Web trước sửa vào TEMP để đối chiếu, giữ nguyên các thay đổi đang có.

| ID / yêu cầu | Trạng thái trước | Căn cứ từ source/test | Hành động / ưu tiên |
|---|---|---|---|
| A01 USB binary, CRC, sequence, index wrap | COMPLETE | parseSerialBytes/receiveStreamPacket; test_pc_stream_web | SKIPPED, giữ giao thức / P0 |
| A02 DMA/queue/firmware/Keil/LCD | COMPLETE | PC_PROTOCOL, firmware và test C | SKIPPED, không sửa firmware |
| A03 Mode/rate/depth cấu hình một nơi | NEEDS_IMPROVEMENT | setMode/syncRate dùng hai cặp dropdown; depth cố định | bỏ Acquisition lặp; toolbar thống nhất / P0 |
| A04 Depth/duration/requested/actual | PARTIAL | makeConfigPayload luôn8192; applyConfig bỏ depth/requested | dùng depth firmware cho phép, tách PC buffer và actual / P0 |
| A05 Disable khi đang thu | PARTIAL | chỉ trigger trong stream bị disable | khóa cấu hình hardware theo state thực / P0 |
| A06 Trigger capture | PARTIAL | index có nhưng không giữ trigger type của capture | metadata theo bản thu, Go to Trigger / P0 |
| A07 Trigger và time stream | NEEDS_FIX | flushStreamView đặt trigger ở mẫu cuối, nhãn âm | timeline từ sample index tuyệt đối, không trigger giả / P0 |
| A08 Zoom/wheel/pan/snap/edge navigation | COMPLETE | setupCanvasInteraction, nearestEdge, navigateEdge | giữ thuật toán thao tác; tích hợp geometry mới / P1 |
| A09 Zoom selection, Go to Cursor | MISSING | không có selection/goto | bổ sung / P1 |
| A10 Zoom/cursor khi nhận stream | NEEDS_FIX | mỗi flush reset view và cursor | giữ vị trí; Follow/Pause/Live / P0 |
| A11 Overview và sample points | MISSING | drawWaveform không có | thêm overview và điểm mẫu ở zoom gần / P1 |
| A12 Xung ngắn khi zoom xa | NEEDS_FIX | vòng vẽ nhảy index theo step | min/max/edge bins từ raw, không mất pulse / P0 |
| A13 Decoder lane riêng | MISSING | drawProtocolOverlays đè raw lanes | lanes dùng cùng trục thời gian / P0 |
| A14 Lane bits/frame/transaction/error | PARTIAL | chỉ annotation byte/data, thiếu cấu trúc chi tiết | lớp record chung, expand lanes / P0 |
| A15 UART sampling/UNSYNC | COMPLETE | test phases/jitter và fixture boundary | giữ mốc cạnh trung điểm, trust semantics / P0 |
| A16 UART parity/data/stop/order/TX | PARTIAL | cố định RX 8-N-1 LSB | cấu hình software, parity/incomplete diagnostics / P1 |
| A17 SPI CS/Mode0–3/MOSI/MISO | COMPLETE | test 256 byte mỗi mode, timing/CS bounds | giữ semantics, thêm records chi tiết / P0 |
| A18 SPI word size/order/CS polarity | MISSING | cố định 8 MSB active-low | bổ sung cấu hình decoder software / P1 |
| A19 I2C 7-bit/RW/ACK/restart/STOP | COMPLETE | test oracle và ambiguity | giữ; NACK là thông tin, không tự coi lỗi / P0 |
| A20 I2C transaction/bits/incomplete | PARTIAL | events rời, warnings chung | liên kết transaction và components / P0 |
| A21 Cross-block decoder state | NEEDS_FIX | decode lại snapshot mỗi50ms; 500k vượt8k giữa UI ticks | incremental state nhận mọi block, record ID ổn định / P0 |
| A22 Cấu hình đổi và decoder cache | PARTIAL | cache theo snapshot/settings; không có stream context | reset/replay raw khi đổi; không giữ kết quả cấu hình cũ / P0 |
| A23 Gap/overflow | PARTIAL | fail-fast giữ prefix nhưng không marker/metadata | gap unknown boundary, reset decoder, không nối data / P0 |
| A24 Stream1MSa/pattern/pulse trigger | BLOCKED | firmware không hỗ trợ | ghi giới hạn; không mở rate/command / P0 |
| A25 Channel checkbox/All/None/map/logic A/B | COMPLETE | channel controls và cursor info | SKIPPED chức năng, đồng bộ layout / P1 |
| A26 Channel name/color/order/height/group | MISSING | D0..7 và COLORS cố định | metadata hiển thị độc lập bit vật lý / P1,P2 |
| A27 Sidebar/bottom resize/collapse/expand | MISSING | CSS grid cố định | handles/keyboard, layout lưu local / P1 |
| A28 Table và waveform hai chiều | PARTIAL | click row chỉ chuyển cursor | record ID, highlight, tooltip/detail / P0 |
| A29 Protocol Analyzer trùng bảng | NEEDS_IMPROVEMENT | renderProtocolSummary lặp decode và SPI/I2C tables | hợp nhất Data/Frame/Transaction view / P0 |
| A30 Table search/filter/sort/copy/export | MISSING | bảng300row đầu, không filter | filter và viewport row window / P1 |
| A31 Cursor Δt/logic/snap | COMPLETE | updateCursorInfo và edge tests | giữ / P0 |
| A32 Tên Frequency của 1/Δt | NEEDS_FIX | frequencyText hiện f= | đổi thành1/Δt, không coi là tần số tín hiệu / P0 |
| A33 Auto measurement | PARTIAL | trung bình19period, chỉ một high width | cạnh/pulse hoàn chỉnh, statistics/range/uncertainty / P0 |
| A34 Hover pulse | PARTIAL | có width nhưng clipped chỉ ≥, không highlight | giữ width, highlight pulse/edges, toggle / P1 |
| A35 Event log | PARTIAL | bounded300, auto-scroll/clear; không filter/export/type | severity/type, dedup, export / P1 |
| A36 Status metrics | PARTIAL | status/rate dùng dropdown requested | actual rate, measured RX/sample counters, unknown loss / P0 |
| A37 Session save/open | NEEDS_FIX | v1 chỉsamples/rate, load map&255 và truncate âm thầm | versioned validation, full settings/metadata, atomic load / P0 |
| A38 Raw CSV export | COMPLETE | exportCsv từ raw | giữ; sửa timeline/channels metadata / P1 |
| A39 Decoded/measurement CSV, VCD, PNG | MISSING | chỉ raw CSV/JSON | thêm export có ích / P1 |
| A40 Memory/rAF/parser bounded | COMPLETE | typed parser, ring,20Hz,oneRAF; regressions | giữ giới hạn, thêm giới hạn records / P0 |
| A41 Worker | NOT_APPLICABLE | chưa chứng minh cần concurrency riêng | incremental/cache/bounded UI trước; benchmark / P1 |
| A42 Multiple live devices | NOT_APPLICABLE | một transport/device theo project | một phiên active; file session offline / P2 |
| A43 Advanced precision/jitter | PARTIAL | format3decimals, không Ts/range | độ phân giải sample, statistics có điều kiện / P1,P2 |
| A44 Preferences/theme/shortcuts | PARTIAL | theme toggle, không persist/keyboard | giữ theme; lưu layout/channel prefs và shortcuts / P2 |

Thứ tự triển khai: engine/state/time và phép đo → lanes/render/layout → quản lý
session/table/export → regression và kiểm tra UI. Không chuyển framework hoặc
đổi packet/command/state machine firmware. Các P2 chỉ thêm khi phục vụ phân tích
thực tế, không tạo mock hoặc số liệu để đánh dấu checklist.

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
- Capture chọn 1024/2048/4096/8192 mẫu; thời lượng tính từ depth/Fs.
- Streaming 1/5/10/50/100/500 kSa/s từ firmware 1.4; Capture vẫn có 1 MSa/s.
- Nhận từng block vào ring PC 8/64/256/1024 Ki mẫu (mặc định64 Ki), độc lập SRAM
  STM32. Decoder nhận **mọi block**, không chờ snapshot UI. Vẽ tối đa20 Hz;
  history lớn giảm nhịp snapshot theo dung lượng để tránh gây nghẽn giao diện.
  Không có chức năng ghi toàn phiên vô hạn vào đĩa.
- Kiểm tra CRC, stream ID, sequence và sample index. Khi lỗi hoặc STM32 báo
  OVERRUN, dừng stream và giữ ERROR đến khi Start phiên mới; không nối qua chỗ
  thiếu mẫu. Sau Stop/ngắt kết nối, packet đến muộn không được append.
- Thống kê frequency, period, duty cycle, HIGH width và LOW width.
- UART RX và TX tùy chọn,5–9 data bits, parity None/Even/Odd,1/1.5/2 stop bits,
  LSB/MSB. SPI đủ4 kênh, mode0–3,1–32 bit/word, LSB/MSB, CS LOW/HIGH.
  I²C7-bit có START/restart/address/RW/data/ACK/NACK/STOP;10-bit báo UNSUPPORTED.
- Decoder lanes riêng, dùng cùng trục thời gian. Nhấn tên lane để mở bits,
  components, transaction và lỗi. MOSI/MISO bit hiển thị theo cặp `out/in`.
  Nhấn annotation hoặc hàng dữ liệu để chọn qua lại và highlight vùng thời gian.
- Decoded Data hợp nhất Data/Frame/Transaction view; filter protocol/channel/status,
  search, sort, HEX/Decimal/Binary/ASCII, copy, export, scroll theo viewport.
  Đã bỏ tab Protocol Analyzer trùng chức năng và annotation đè lên raw waveform.
- Save/Load session JSONv2 (đọc v1), raw/decoded/measurement CSV, VCD, PNG;
  log có severity/type/filter/export và theme sáng/tối lưu local.
- Self Test điều khiển trực tiếp từ web: tự chọn 100 kSa/s cho UART, 10 kSa/s
  cho I²C hoặc 500 kSa/s cho SPI, ARM trước rồi mới phát mẫu từ chính STM32.
- Self Test dùng pre-trigger 1% để giữ lại mức idle trước start bit/START.
  Decoder I²C chờ START thực; không đoán START khi capture bắt đầu giữa giao dịch.
- Decoder UART xác nhận mức giữa start bit để loại xung nhiễu ngắn và byte giả.
- UART dùng trung điểm khoảng HIGH→LOW làm mốc start để giảm sai lệch timing
  ở 500 kSa/s / 115200 baud. Bảng ghi `STOP BIT OK` khi stop bit hợp lệ; không
  dùng chữ OK để ngụ ý mọi bit dữ liệu đã được kiểm tra bằng checksum.
- UART đầu capture/rolling window chưa có mốc đồng bộ được gắn UNSYNC trên bảng
  và waveform. Idle HIGH ≥10 bit giúp xác nhận lại ranh giới; UART liên tục không
  có gap dài vẫn hiện byte ước đoán, không bị bỏ toàn bộ dữ liệu.
- Menu Protocols dùng các hàng nhãn/dropdown thẳng cột, có thông báo cấu hình sai,
  frame thiếu và độ phân giải thời gian. Xem [hướng dẫn decoder](../docs/PROTOCOL_DECODERS.md).

Phần Trigger nằm đầu sidebar; Acquisition lặp đã bỏ. `Position` xác định
tỷ lệ dữ liệu nằm trước thời điểm trigger. Channel Legend đã được bỏ vì màu và
tên kênh đã hiển thị trực tiếp trên waveform và danh sách Channels.

Kết quả build hoặc chạy dashboard không chứng minh khả năng lấy mẫu 1 MHz trên
phần cứng. Cần kiểm thử với STM32 và nguồn tín hiệu thực tế.

## Self Test không cần thiết bị ngoài

Nạp firmware 1.5 mới, kết nối USB CDC và đấu dây theo protocol muốn thử:

| Self Test | Dây loopback |
|---|---|
| UART | PA9 → PA0/D0 |
| I²C | PB10 → PA0/D0, PB11 → PA1/D1 |
| SPI | PB13 → PA0/D0, PB15 → PA1/D1 |

Tháo dây PB0 khỏi PA0 trước khi chạy protocol self-test. Trong mục **Self
Test**, chọn protocol, chọn One Shot hoặc Repeat rồi nhấn **Run Test**. Web tự
chọn sample rate, trigger và decoder. **Stop Test** chỉ dừng bộ phát; nút Stop
trên thanh công cụ dừng cả bộ phát và acquisition.

Bộ phát SPI self-test hiện tại chỉ có SCK/MOSI, không đủ để nghiệm thu decoder
SPI bốn chân mới. Phần cập nhật decoder phục vụ đo bus thực tế; firmware self-test
và pin mapping không thay đổi.

## Kiểm thử streaming

Xem [PC_STREAMING_GUIDE.md](../docs/PC_STREAMING_GUIDE.md) để build, chọn tốc độ,
kiểm tra queue/OVERRUN và stress test trên board. Sau khi cập nhật `app.js`, dùng
Ctrl+F5 để tránh cache giao diện cũ.

Firmware 1.5 phân loại OVERRUN thành QUEUE_FULL hoặc DMA_LATE. Web giữ lỗi phiên
trên UI nhưng log ACK dùng state MCU thật, tránh hiểu nhầm STOP vẫn lỗi.
Bộ đệm Web Serial đã tăng từ 16 KiB lên 1 MiB ở PC để hấp thụ các đợt JS tạm
bận; đóng/kết nối lại COM để áp dụng. Điều này chưa chứng minh stream 500k ổn định
trên phần cứng và không thay thế kiểm thử dài hạn.

Host test parser/ring/continuity/UI scheduling: `node Tests/test_pc_stream_web.cjs`
(chạy từ thư mục project với Node.js). Đây là mô phỏng, không thay thế phép đo USB
và thời gian render trên PC thực tế.

Host test decoder và đồng bộ shared records/table: `node Tests/test_protocol_decoders.cjs`.

## Workbench v2 — cách dùng

- **Layout**: ẩn/hiện panel hoặc mở rộng waveform. Kéo vạch giữa sidebar và
  waveform để đổi chiều rộng; kéo vạch phía trên kết quả để đổi chiều cao.
- **Channels**: nhấn tên để sửa name/color/height/group. Kéo hàng để đổi thứ tự.
  Nhấn tên group trên waveform để thu/mở. Bit D0..D7/PA0..PA7 luôn giữ nguyên.
- **Timeline**: wheel zoom tại chuột; Pan hoặc Shift/right-drag; Select rồi
  `▧+` zoom vùng. Overview kéo khung để pan, kéo cạnh khung để zoom.
  Có Go T/A/B, sample points khi zoom gần, major/minor grid và bins bảo toàn
  xung ngắn khi zoom xa. Bins chỉ phục vụ vẽ, không dùng cho decode/measurement.
- **Streaming**: Follow Live giữ cuối timeline; Paused view đóng băng một snapshot
  để phân tích trong khi USB/decoder vẫn chạy. Go Live bỏ vùng chọn và về dữ liệu
  mới nhất, giữ độ rộng zoom. Cursor giữ sample index tuyệt đối; hết history hiện
  expired/—, không tự chuyển sang mẫu khác. Thời gian stream = absolute index/Fs,
  không có T giả hoặc trục thời gian âm. Stream1 MSa/s chưa được firmware hỗ trợ.
- **Cursor**: Snap bật = cạnh gần nhất; tắt = sample gần nhất. Khoảng A–B được
  tô nhẹ; `1/|Δt|` là nghịch đảo khoảng thời gian, không phải frequency tự động.
- **Auto measure**: bật/tắt ở thanh timeline. Hover pulse để xem width và, nếu
  đủ hai pulse, period/frequency/duty. Pulse bị cắt hiện `≥` và không đo chu kỳ
  suy đoán. Cạnh dùng đo được đánh dấu. Measurements chọn Full/Visible/A–B;
  cột phải có min/mean/max high/low/period/duty, edge counts, Ts và σ(period).
- **Decoded Data**: nhấn tên lane để mở chi tiết; tìm HEX hoặc ASCII, chọn format,
  Data/Frames/Transactions, Filters cho channel/status, Clear filters. Click lane
  sẽ mở bộ lọc nếu cần để thấy hàng được chọn. Follow rows độc lập Follow Live.
- **Save/Load**: Save ghi toàn bộ raw đang giữ, origin/Fs, trigger metadata, mode,
  channels/order/visibility, decoder config/records, gaps, viewport và cursors.
  Load kiểm tra hoàn chỉnh trước khi thay dữ liệu, chặn khi MCU đang thu, hỏi khi
  thay snapshot hiện có. File v1 thiếu metadata không được tự đoán trigger type.
  Load không gửi cấu hình lên STM32. Decoder đổi khi xem lịch sử sẽ giải mã lại
  raw còn giữ, nên có thể báo UNSYNC/CAPTURE BOUNDARY nếu không còn đầu giao dịch.
- **Export**: raw CSV là raw samples và absolute sample index/time; VCD timescale
  1ns là đơn vị lưu timestamp, không làm tăng độ chính xác Fs. PNG chụp waveform
  và time ruler đang xem; CSV measurements có range/origin/Fs của snapshot xuất.
- **Shortcuts** ngoài ô nhập: Space Start/Stop, +/− zoom, F fit, A/B chọn cursor,
  ←/→ tìm cạnh. Name/color/order/visibility/decoder/theme/panel size lưu local.

Thông số UART dưới8 samples/bit là cảnh báo; dưới3 samples/bit decoder này từ
chối giải mã. STOP BIT OK không kiểm tra được mọi lỗi data. Jitter là độ lệch
chuẩn **period quan sát**, gồm lượng tử hóa Fs; không phải jitter phần cứng đã
hiệu chuẩn. Frequency hiển thị là1/mean(period hoàn chỉnh). Không đủ cạnh hiện—.

## Kiến trúc Web sau cải tiến

`app.js` giữ Web Serial, binary parser/CRC, command/ACK/state machine và tải
capture theo chunk512. `analysis.js` là engine thuần, dùng sample index, không
biết DOM/USB. `workbench.js` quản lý raw PC ring, decoder session, view, table,
canvas, session và export. `analysis_worker.js` dùng lại LA.measure cho thống kê
streaming; không có bản sao thuật toán khác và không sở hữu USB.

```text
USB bytes → parser/CRC → validate ID/sequence/index/flags
  Capture: GET_DATA chunks → raw snapshot → batch Decoder
  Stream: every block → raw ring + incremental Decoder
               ↓ bounded snapshot (max20Hz; adaptive for large history)
     waveform bins / shared records / table viewport / measurements worker
```

Một sample =8 bit vật lý. Raw ring tối đa1 MiB, frozen view tối đa1 MiB cộng
snapshot gửi worker. Decoder giữ tối đa24.000 records nội bộ, trả tối đa12.000
records gần nhất; log tối đa300; table chỉ dựng khoảng30–80 rows. **Raw còn giữ
không có nghĩa mọi decoded record cũ còn giữ**: nếu hết record retention, có thể
giải mã lại raw (mốc đầu có thể UNSYNC). Không tự nối qua gap hay chèn zero.

Gap/CRC/OVERRUN giữ raw prefix hợp lệ và ERROR đến Start phiên mới. Gap ở biên
sau prefix có missing=null: số mẫu thiếu **Unknown**, không đổi dropped block
thành số mẫu đoán. PC eviction là bỏ lịch sử theo capacity, khác transport loss.
Status hiển thị byte RX và throughput trung bình đo trên PC; sampling Fs lấy từ
metadata MCU. DMA/queue usage không có trong protocol nên không giả làm số đo.

Worker phục vụ trường hợp history lớn: thử tổng hợp500.000 samples trên host này,
thống kê8 kênh ban đầu khoảng240ms; bản accumulator khoảng108ms (không gồm DOM/USB).
Vì vẫn có thể dài hơn chu kỳ UI, phép đo stream chạy trong worker, một job UI
đang chờ; response cũ bị loại. CSV phép đo chụp raw/range riêng và chờ worker.
Không có worker thì fallback main thread và có log cảnh báo; nên dùng history
nhỏ khi kiểm thử hiệu năng. Đây là benchmark tổng hợp, không phải bảo đảm500k.

## Kết quả theo audit ngày24/11/2026

| ID | Trước | Sau | File chính | Test / giới hạn |
|---|---|---|---|---|
| A01 | COMPLETE | SKIPPED | app.js | parser/stream regression PASS |
| A02 | COMPLETE | SKIPPED | Core/USB/ioc/Keil |25 SHA256 không đổi; host C PASS |
| A03 | NEEDS_IMPROVEMENT | REMOVED/IMPROVED | index/workbench | một bộ hardware controls; DOM PASS |
| A04 | PARTIAL | IMPROVED | app/workbench | depth payload, duration, requested/actual PASS |
| A05 | PARTIAL | FIXED | workbench | actual state/config locks PASS |
| A06 | PARTIAL | FIXED | app/workbench | trigger/NONE metadata PASS |
| A07 | NEEDS_FIX | FIXED | workbench | absolute stream time/noT PASS |
| A08 | COMPLETE | SKIPPED/IMPROVED | app/workbench | edge helpers giữ; geometry mới, cần UI thực |
| A09 | MISSING | ADDED | workbench | region/GoTo; cần thao tác chuột thực |
| A10 | NEEDS_FIX | FIXED | workbench | pause/live/cursor expiry/zoom PASS |
| A11 | MISSING | ADDED | workbench | overview/real points; canvas contract PASS |
| A12 | NEEDS_FIX | FIXED | analysis/workbench | single-sample pulse bins PASS |
| A13 | MISSING | ADDED | index/workbench | decoder lanes tách raw; cần QA trực quan |
| A14 | PARTIAL | IMPROVED | analysis/workbench | bit/component/transaction/error records PASS |
| A15 | COMPLETE | SKIPPED | analysis | byte0–255, phase/jitter, boundary fixture PASS |
| A16 | PARTIAL | ADDED | analysis/index | format/parity/TX; synthetic formats PASS |
| A17 | COMPLETE | SKIPPED | analysis |4 SPI modes/256 words/timing PASS |
| A18 | MISSING | ADDED | analysis/index | LSB16/active-high/all splits PASS |
| A19 | COMPLETE | SKIPPED | analysis | address/RW/ACK/restart/NACK PASS |
| A20 | PARTIAL | IMPROVED | analysis | incomplete/transactions/all splits PASS |
| A21 | NEEDS_FIX | FIXED | analysis/workbench | every split UART/SPI/I2C PASS |
| A22 | PARTIAL | IMPROVED | workbench | cache and paused config isolation PASS |
| A23 | PARTIAL | IMPROVED | app/analysis | fail-fast/gap/reset/PREFIX PASS |
| A24 | BLOCKED | BLOCKED | firmware unchanged | stream1M/pattern/pulse trigger cần firmware riêng |
| A25 | COMPLETE | SKIPPED | workbench | physical bit mapping/cursor states PASS |
| A26 | MISSING | ADDED | workbench/index | metadata roundtrip PASS; drag cần UI thực |
| A27 | MISSING | ADDED | styles/workbench | resize/collapse; cần QA kích thước thực |
| A28 | PARTIAL | IMPROVED | workbench | shared ID/select/highlight/table contract PASS |
| A29 | NEEDS_IMPROVEMENT | REMOVED/IMPROVED | index/workbench | một bảng Data/Frames/Transactions PASS |
| A30 | MISSING | ADDED | workbench |6000-row fixture/filter/format/virtual rows PASS |
| A31 | COMPLETE | SKIPPED | app/workbench | cursor/snap/edges giữ, kiểm tra state PASS |
| A32 | NEEDS_FIX | FIXED | workbench | nhãn1/absΔt, signedΔt PASS |
| A33 | PARTIAL | FIXED/IMPROVED | analysis/worker | range/complete pulses/stats/worker PASS |
| A34 | PARTIAL | IMPROVED | workbench | toggle/width/cycle/edges; cần hover thực |
| A35 | PARTIAL | IMPROVED | workbench | bounded/severity/category/dedup/export |
| A36 | PARTIAL | IMPROVED | app/workbench | counters, real/device/data separation PASS |
| A37 | NEEDS_FIX | FIXED | analysis/workbench |v1/v2/atomic/invalid/live-blocked PASS |
| A38 | COMPLETE | IMPROVED | workbench | raw/absolute timeline CSV PASS |
| A39 | MISSING | ADDED | analysis/workbench | CSV/VCD/export snapshot PASS; PNG cần browser |
| A40 | COMPLETE | IMPROVED | analysis/workbench | bounded parser/ring/records/table/oneRAF PASS |
| A41 | NOT_APPLICABLE trước benchmark | ADDED có căn cứ | analysis_worker | measurement bottleneck; stale worker job PASS |
| A42 | NOT_APPLICABLE | NOT_APPLICABLE | một Web Serial port | nhiều session đo đồng thời chưa phù hợp |
| A43 | PARTIAL | IMPROVED | analysis/workbench | Ts, range, pulse stats/jitter có điều kiện PASS |
| A44 | PARTIAL | IMPROVED | workbench/styles | prefs và shortcuts; cần keyboard/resize QA thực |

File thêm: `AppWeb/analysis.js`, `AppWeb/workbench.js`, `AppWeb/analysis_worker.js`,
`Tests/test_analysis.cjs`, `Tests/test_workbench.cjs`.
File sửa: `AppWeb/app.js`, `AppWeb/index.html`, `AppWeb/styles.css`, README này,
`Tests/test_protocol_decoders.cjs`, `Tests/test_pc_stream_web.cjs`,
`Tests/run_pc_stream_tests.ps1`, `docs/PROTOCOL_DECODERS.md`, `docs/architecture.md`.
Không xóa file; xóa các hàm batch decoder/render cũ đã được thay bởi engine chung
và UI mới. Backup Web trước sửa nằm trong TEMP phiên làm việc, không dùng làm
dependency chạy app. Không đổi `.ioc`, pin, DMA/Timer, USB protocol hay Keil.

## Kiểm thử và giới hạn xác minh

```powershell
node Tests/test_protocol_decoders.cjs
node Tests/test_pc_stream_web.cjs
node Tests/test_analysis.cjs
node Tests/test_workbench.cjs
.\Tests\run_pc_stream_tests.ps1
```

Đã chạy4 suite JS bằng Node runtime cùng source production: PASS. C regression
PC stream, LCD bounds/edges/workspace và LCD hardware scroll: PASS với GCC host.
JS parse/syntax: PASS; project không có cấu hình linter/bundler nên không tuyên
bố đã chạy ESLint hoặc build framework. Worker được kiểm tra bằng message
contract và thuật toán thật; DOM/canvas harness kiểm tra ID/initialization/draw
calls, không thay thế CSS layout/browser QA. Parser/ring benchmark khoảng28–40MB/s
ở các lần chạy tổng hợp, không gồm USB/DOM. HTTP smoke test qua Python server:
index, CSS và4 moduleJS đều trả200, MIME JavaScript/CSS đúng; đã dừng server thử.

Công cụ browser preview báo **browser access host unavailable**; chưa kiểm tra
trực quan Chrome, drag/resize/hover, clipboard, native download, PNG hay FPS thực.
Chưa kiểm thử USB/STM32 dài hạn, tín hiệu UART/SPI/I²C thật hoặc waveform LCD
sau thay đổi Web. Không kết luận firmware hoặc stream500k đã chạy ổn trên board.
Không cần rebuild/nạp Keil cho thay đổi Web; Ctrl+F5 hoặc đóng/mở dashboard để
tải đủ các fileJS/CSS mới. Dùng firmware hiện tại và nghiệm thu capture/stream
trên board trước khi coi đạt tốc độ danh định.

Nghiệm thu trên PC/board:

1. Chạy batch, Ctrl+F5, mở DevTools Console kiểm tra không có lỗiJS/404Worker.
   Khi chưa kết nối phải trống waveform. Thử panel resize ở độ phân giải thực.
2. Capture NONE rồi Rising/Falling, thử cả4 depth: đối chiếu số mẫu/thời lượng,
   markerT và rawCSV. NONE phải không có markerT.
3. Stream lần lượt các rate firmware cho phép. Pause Follow: counter RX vẫn tăng
   nhưng hình giữ nguyên; Go Live: về mẫu mới nhất, zoom span giữ nguyên.
4. Dùng nguồn UART/SPI/I²C đã biết, đặt đúng format/pin. Đối chiếu byte, bit,
   ACK/NACK và lỗi trên lane/bảng. Thử frame qua nhiều block, biên đầu/cuối chưa
   đủ và STOP/CS ở ranh giới. Sample rate không thể sửa dây sai/nhiễu/aliasing.
5. Chọn A/B, snap, tìm cạnh, kéo overview/selection; đổi tên/order/color và xác
   nhận physical D0..D7 không đổi. Save→Load offline phải giữ raw/Fs/time/config.
6. Thử CSV/VCD trên công cụ đích, PNG/clipboard/download trên Chrome thực.
   Stress500k và history lớn: theo dõi ERROR/OVERRUN, không bỏ qua gap rồi tiếp
   tục coi là dữ liệu liên tục. Ghi lại thời gian chạy/PC/driver khi nghiệm thu.
