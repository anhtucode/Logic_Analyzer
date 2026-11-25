#include "pc_interface.h"
#include "acquisition.h"
#include "self_test.h"
#include "usb_device.h"
#include "usbd_cdc.h"
#include "usbd_cdc_if.h"
#include <stdbool.h>
#include <string.h>

#define PC_SYNC_0             0xA5U
#define PC_SYNC_1             0x5AU
#define PC_PROTOCOL_VERSION   0x01U
#define PC_RX_RING_SIZE       256U
#define PC_MAX_COMMAND_DATA   32U
#define PC_TX_BUFFER_SIZE     1100U
#define PC_DATA_CHUNK         512U

enum
{
  CMD_GET_INFO = 0x01,
  CMD_GET_STATUS = 0x02,
  CMD_GET_CONFIG = 0x03,
  CMD_SET_CONFIG = 0x04,
  CMD_ARM = 0x05,
  CMD_STOP = 0x06,
  CMD_GET_DATA = 0x07,
  CMD_START_STREAM = 0x08,
  CMD_STOP_STREAM = 0x09,
  CMD_RUN_SELF_TEST = 0x0A,
  CMD_STOP_SELF_TEST = 0x0B,
  RSP_ACK = 0x80,
  RSP_NACK = 0x81,
  RSP_INFO = 0x82,
  RSP_STATUS = 0x83,
  RSP_CONFIG = 0x84,
  RSP_DATA = 0x85,
  RSP_STREAM = 0x86
};

static volatile uint8_t rx_ring[PC_RX_RING_SIZE];
static volatile uint16_t rx_write;
static volatile uint16_t rx_read;
static volatile bool rx_overflow;

static uint8_t tx_buffer[PC_TX_BUFFER_SIZE];
static uint16_t tx_length;
static bool tx_queued;
static bool tx_in_flight;
static bool usb_was_connected;
static uint8_t stream_sequence;

extern USBD_HandleTypeDef hUsbDeviceFS;

static void PutU16(uint8_t *p, uint16_t value)
{
  p[0] = (uint8_t)value;
  p[1] = (uint8_t)(value >> 8);
}

static void PutU32(uint8_t *p, uint32_t value)
{
  p[0] = (uint8_t)value;
  p[1] = (uint8_t)(value >> 8);
  p[2] = (uint8_t)(value >> 16);
  p[3] = (uint8_t)(value >> 24);
}

static uint16_t GetU16(const uint8_t *p)
{
  return (uint16_t)p[0] | ((uint16_t)p[1] << 8);
}

static uint32_t GetU32(const uint8_t *p)
{
  return (uint32_t)p[0] | ((uint32_t)p[1] << 8) |
         ((uint32_t)p[2] << 16) | ((uint32_t)p[3] << 24);
}

static uint16_t Crc16(const uint8_t *data, uint16_t length)
{
  /* Bang const nam trong Flash: CRC cung polynomial/initial value nhu truoc,
     nhung chi can mot lan tra bang cho moi byte stream. */
  static const uint16_t table[256] =
  {
    0x0000U, 0x1021U, 0x2042U, 0x3063U, 0x4084U, 0x50A5U, 0x60C6U, 0x70E7U,
    0x8108U, 0x9129U, 0xA14AU, 0xB16BU, 0xC18CU, 0xD1ADU, 0xE1CEU, 0xF1EFU,
    0x1231U, 0x0210U, 0x3273U, 0x2252U, 0x52B5U, 0x4294U, 0x72F7U, 0x62D6U,
    0x9339U, 0x8318U, 0xB37BU, 0xA35AU, 0xD3BDU, 0xC39CU, 0xF3FFU, 0xE3DEU,
    0x2462U, 0x3443U, 0x0420U, 0x1401U, 0x64E6U, 0x74C7U, 0x44A4U, 0x5485U,
    0xA56AU, 0xB54BU, 0x8528U, 0x9509U, 0xE5EEU, 0xF5CFU, 0xC5ACU, 0xD58DU,
    0x3653U, 0x2672U, 0x1611U, 0x0630U, 0x76D7U, 0x66F6U, 0x5695U, 0x46B4U,
    0xB75BU, 0xA77AU, 0x9719U, 0x8738U, 0xF7DFU, 0xE7FEU, 0xD79DU, 0xC7BCU,
    0x48C4U, 0x58E5U, 0x6886U, 0x78A7U, 0x0840U, 0x1861U, 0x2802U, 0x3823U,
    0xC9CCU, 0xD9EDU, 0xE98EU, 0xF9AFU, 0x8948U, 0x9969U, 0xA90AU, 0xB92BU,
    0x5AF5U, 0x4AD4U, 0x7AB7U, 0x6A96U, 0x1A71U, 0x0A50U, 0x3A33U, 0x2A12U,
    0xDBFDU, 0xCBDCU, 0xFBBFU, 0xEB9EU, 0x9B79U, 0x8B58U, 0xBB3BU, 0xAB1AU,
    0x6CA6U, 0x7C87U, 0x4CE4U, 0x5CC5U, 0x2C22U, 0x3C03U, 0x0C60U, 0x1C41U,
    0xEDAEU, 0xFD8FU, 0xCDECU, 0xDDCDU, 0xAD2AU, 0xBD0BU, 0x8D68U, 0x9D49U,
    0x7E97U, 0x6EB6U, 0x5ED5U, 0x4EF4U, 0x3E13U, 0x2E32U, 0x1E51U, 0x0E70U,
    0xFF9FU, 0xEFBEU, 0xDFDDU, 0xCFFCU, 0xBF1BU, 0xAF3AU, 0x9F59U, 0x8F78U,
    0x9188U, 0x81A9U, 0xB1CAU, 0xA1EBU, 0xD10CU, 0xC12DU, 0xF14EU, 0xE16FU,
    0x1080U, 0x00A1U, 0x30C2U, 0x20E3U, 0x5004U, 0x4025U, 0x7046U, 0x6067U,
    0x83B9U, 0x9398U, 0xA3FBU, 0xB3DAU, 0xC33DU, 0xD31CU, 0xE37FU, 0xF35EU,
    0x02B1U, 0x1290U, 0x22F3U, 0x32D2U, 0x4235U, 0x5214U, 0x6277U, 0x7256U,
    0xB5EAU, 0xA5CBU, 0x95A8U, 0x8589U, 0xF56EU, 0xE54FU, 0xD52CU, 0xC50DU,
    0x34E2U, 0x24C3U, 0x14A0U, 0x0481U, 0x7466U, 0x6447U, 0x5424U, 0x4405U,
    0xA7DBU, 0xB7FAU, 0x8799U, 0x97B8U, 0xE75FU, 0xF77EU, 0xC71DU, 0xD73CU,
    0x26D3U, 0x36F2U, 0x0691U, 0x16B0U, 0x6657U, 0x7676U, 0x4615U, 0x5634U,
    0xD94CU, 0xC96DU, 0xF90EU, 0xE92FU, 0x99C8U, 0x89E9U, 0xB98AU, 0xA9ABU,
    0x5844U, 0x4865U, 0x7806U, 0x6827U, 0x18C0U, 0x08E1U, 0x3882U, 0x28A3U,
    0xCB7DU, 0xDB5CU, 0xEB3FU, 0xFB1EU, 0x8BF9U, 0x9BD8U, 0xABBBU, 0xBB9AU,
    0x4A75U, 0x5A54U, 0x6A37U, 0x7A16U, 0x0AF1U, 0x1AD0U, 0x2AB3U, 0x3A92U,
    0xFD2EU, 0xED0FU, 0xDD6CU, 0xCD4DU, 0xBDAAU, 0xAD8BU, 0x9DE8U, 0x8DC9U,
    0x7C26U, 0x6C07U, 0x5C64U, 0x4C45U, 0x3CA2U, 0x2C83U, 0x1CE0U, 0x0CC1U,
    0xEF1FU, 0xFF3EU, 0xCF5DU, 0xDF7CU, 0xAF9BU, 0xBFBAU, 0x8FD9U, 0x9FF8U,
    0x6E17U, 0x7E36U, 0x4E55U, 0x5E74U, 0x2E93U, 0x3EB2U, 0x0ED1U, 0x1EF0U,
  };
  uint16_t crc = 0xFFFFU;

  while (length-- != 0U)
  {
    crc = (uint16_t)((crc << 8) ^ table[(uint8_t)((crc >> 8) ^ *data++)]);
  }
  return crc;
}

static bool UsbConnected(void)
{
  return (hUsbDeviceFS.dev_state == USBD_STATE_CONFIGURED) &&
         (hUsbDeviceFS.pClassData != NULL);
}

static bool TxAvailable(void)
{
  return !tx_queued && !tx_in_flight;
}

static bool BuildFrame(uint8_t type, uint8_t sequence,
                       const uint8_t *payload, uint16_t payload_length)
{
  uint16_t crc;

  if (!TxAvailable() || ((uint32_t)payload_length + 9U > PC_TX_BUFFER_SIZE))
  {
    return false;
  }
  tx_buffer[0] = PC_SYNC_0;
  tx_buffer[1] = PC_SYNC_1;
  tx_buffer[2] = PC_PROTOCOL_VERSION;
  tx_buffer[3] = type;
  tx_buffer[4] = sequence;
  PutU16(&tx_buffer[5], payload_length);
  if ((payload != NULL) && (payload_length != 0U) &&
      (payload != &tx_buffer[7]))
  {
    memcpy(&tx_buffer[7], payload, payload_length);
  }
  crc = Crc16(&tx_buffer[2], (uint16_t)(5U + payload_length));
  PutU16(&tx_buffer[7U + payload_length], crc);
  tx_length = (uint16_t)(9U + payload_length);
  tx_queued = true;
  return true;
}

static void ServiceTx(void)
{
  USBD_CDC_HandleTypeDef *cdc;

  if (!UsbConnected())
  {
    tx_queued = false;
    tx_in_flight = false;
    return;
  }
  cdc = (USBD_CDC_HandleTypeDef *)hUsbDeviceFS.pClassData;
  if (tx_in_flight && (cdc->TxState == 0U))
  {
    tx_in_flight = false;
  }
  if (tx_queued && !tx_in_flight &&
      (CDC_Transmit_FS(tx_buffer, tx_length) == USBD_OK))
  {
    tx_queued = false;
    tx_in_flight = true;
  }
}

static uint16_t RxCount(void)
{
  return (uint16_t)((rx_write - rx_read) & (PC_RX_RING_SIZE - 1U));
}

static uint8_t RxPeek(uint16_t offset)
{
  return rx_ring[(rx_read + offset) & (PC_RX_RING_SIZE - 1U)];
}

static void RxDrop(uint16_t count)
{
  rx_read = (uint16_t)((rx_read + count) & (PC_RX_RING_SIZE - 1U));
}

static void SendCommandResult(uint8_t sequence, uint8_t command,
                              bool accepted, LA_Error error)
{
  LA_Status state;
  uint8_t payload[4];

  LA_GetStatus(&state);
  payload[0] = command;
  payload[1] = (uint8_t)state.state;
  payload[2] = (uint8_t)error;
  payload[3] = 0U;
  (void)BuildFrame(accepted ? RSP_ACK : RSP_NACK, sequence,
                   payload, sizeof(payload));
}

static void SendInfo(uint8_t sequence)
{
  static const uint8_t info[] =
  {
    1U, 5U,             /* firmware 1.5: phan loai queue-full / DMA-late */
    8U,                 /* 8 kenh PA0..PA7 */
    1U,                 /* protocol version */
    0x00U, 0x20U,       /* 8192 samples */
    0x40U, 0x42U, 0x0FU, 0x00U /* 1 MHz */
  };
  (void)BuildFrame(RSP_INFO, sequence, info, sizeof(info));
}

static void SendConfig(uint8_t sequence)
{
  LA_Config value;
  uint8_t payload[20];

  LA_GetConfig(&value);
  payload[0] = (uint8_t)value.mode;
  payload[1] = (uint8_t)value.trigger;
  payload[2] = value.trigger_channel;
  payload[3] = value.pretrigger_percent;
  PutU16(&payload[4], value.sample_depth);
  PutU16(&payload[6], 0U);
  PutU32(&payload[8], value.requested_rate_hz);
  PutU32(&payload[12], value.actual_rate_hz);
  PutU32(&payload[16], value.timeout_ms);
  (void)BuildFrame(RSP_CONFIG, sequence, payload, sizeof(payload));
}

static void SendStatusFrame(uint8_t sequence)
{
  LA_Status value;
  uint8_t payload[20];

  LA_GetStatus(&value);
  payload[0] = (uint8_t)value.state;
  payload[1] = (uint8_t)value.error;
  PutU16(&payload[2], value.flags);
  PutU32(&payload[4], value.capture_id);
  PutU16(&payload[8], value.valid_samples);
  PutU16(&payload[10], value.trigger_index);
  PutU32(&payload[12], value.actual_rate_hz);
  PutU32(&payload[16], value.dropped_blocks);
  (void)BuildFrame(RSP_STATUS, sequence, payload, sizeof(payload));
}

static bool ApplyConfig(const uint8_t *payload, uint16_t length)
{
  LA_Config value;

  if (length != 20U)
  {
    return false;
  }
  value.mode = (LA_Mode)payload[0];
  value.trigger = (LA_Trigger)payload[1];
  value.trigger_channel = payload[2];
  value.pretrigger_percent = payload[3];
  value.sample_depth = GetU16(&payload[4]);
  value.requested_rate_hz = GetU32(&payload[8]);
  value.actual_rate_hz = 0U;
  value.timeout_ms = GetU32(&payload[16]);
  return LA_SetConfig(&value);
}

static void SendData(uint8_t sequence, const uint8_t *request, uint16_t length)
{
  LA_Status state;
  uint16_t offset;
  uint16_t count;
  uint16_t copied;
  uint8_t *payload = &tx_buffer[7];

  if ((length != 4U) || !TxAvailable())
  {
    SendCommandResult(sequence, CMD_GET_DATA, false, LA_ERROR_BAD_PACKET);
    return;
  }
  offset = GetU16(request);
  count = GetU16(&request[2]);
  if (count > PC_DATA_CHUNK)
  {
    count = PC_DATA_CHUNK;
  }
  LA_GetStatus(&state);
  PutU32(&payload[0], state.capture_id);
  PutU16(&payload[4], offset);
  PutU16(&payload[6], count);
  PutU16(&payload[8], state.trigger_index);
  PutU16(&payload[10], state.flags);
  PutU32(&payload[12], state.actual_rate_hz);
  copied = LA_ReadSamples(offset, &payload[16], count);
  PutU16(&payload[6], copied);
  if (copied == 0U)
  {
    SendCommandResult(sequence, CMD_GET_DATA, false, LA_ERROR_NOT_READY);
    return;
  }
  (void)BuildFrame(RSP_DATA, sequence, payload, (uint16_t)(16U + copied));
}

static void HandleCommand(uint8_t command, uint8_t sequence,
                          const uint8_t *payload, uint16_t length)
{
  LA_Status status;
  LA_Config config;
  bool ok;

  switch (command)
  {
    case CMD_GET_INFO:
      if (length == 0U) SendInfo(sequence);
      else SendCommandResult(sequence, command, false, LA_ERROR_BAD_PACKET);
      break;
    case CMD_GET_STATUS:
      if (length == 0U) SendStatusFrame(sequence);
      else SendCommandResult(sequence, command, false, LA_ERROR_BAD_PACKET);
      break;
    case CMD_GET_CONFIG:
      if (length == 0U) SendConfig(sequence);
      else SendCommandResult(sequence, command, false, LA_ERROR_BAD_PACKET);
      break;
    case CMD_SET_CONFIG:
      ok = ApplyConfig(payload, length);
      LA_GetStatus(&status);
      SendCommandResult(sequence, command, ok, status.error);
      break;
    case CMD_ARM:
      ok = (length == 0U) && LA_Start();
      LA_GetStatus(&status);
      SendCommandResult(sequence, command, ok, status.error);
      break;
    case CMD_STOP:
      if (length == 0U)
      {
        SelfTest_Stop();
        LA_Stop();
        SendCommandResult(sequence, command, true, LA_ERROR_NONE);
      }
      else
      {
        SendCommandResult(sequence, command, false, LA_ERROR_BAD_PACKET);
      }
      break;
    case CMD_GET_DATA:
      SendData(sequence, payload, length);
      break;
    case CMD_START_STREAM:
      LA_GetConfig(&config);
      config.mode = LA_MODE_STREAM;
      ok = (length == 0U) && LA_SetConfig(&config) && LA_Start();
      LA_GetStatus(&status);
      SendCommandResult(sequence, command, ok, status.error);
      break;
    case CMD_STOP_STREAM:
      if (length == 0U)
      {
        SelfTest_Stop();
        LA_Stop();
        SendCommandResult(sequence, command, true, LA_ERROR_NONE);
      }
      else
      {
        SendCommandResult(sequence, command, false, LA_ERROR_BAD_PACKET);
      }
      break;
    case CMD_RUN_SELF_TEST:
      LA_GetStatus(&status);
      if (length != 2U)
      {
        SendCommandResult(sequence, command, false, LA_ERROR_BAD_PACKET);
      }
      else if ((payload[0] < (uint8_t)SELF_TEST_UART) ||
               (payload[0] > (uint8_t)SELF_TEST_SPI) ||
               (payload[1] > 1U))
      {
        SendCommandResult(sequence, command, false, LA_ERROR_INVALID_CONFIG);
      }
      else if ((status.state != LA_STATE_ARMED) &&
               (status.state != LA_STATE_TRIGGERED))
      {
        SendCommandResult(sequence, command, false, LA_ERROR_NOT_READY);
      }
      else if (SelfTest_IsActive())
      {
        SendCommandResult(sequence, command, false, LA_ERROR_BUSY);
      }
      else
      {
        ok = SelfTest_Start((SelfTest_Mode)payload[0], payload[1] != 0U);
        SendCommandResult(sequence, command, ok,
                          ok ? LA_ERROR_NONE : LA_ERROR_INVALID_CONFIG);
      }
      break;
    case CMD_STOP_SELF_TEST:
      if (length == 0U)
      {
        SelfTest_Stop();
        SendCommandResult(sequence, command, true, LA_ERROR_NONE);
      }
      else
      {
        SendCommandResult(sequence, command, false, LA_ERROR_BAD_PACKET);
      }
      break;
    default:
      SendCommandResult(sequence, command, false, LA_ERROR_BAD_PACKET);
      break;
  }
}

static void ParseOneCommand(void)
{
  uint16_t payload_length;
  uint16_t frame_length;
  uint16_t received_crc;
  uint16_t calculated_crc;
  uint8_t frame[9U + PC_MAX_COMMAND_DATA];
  uint16_t i;

  while ((RxCount() >= 2U) &&
         ((RxPeek(0U) != PC_SYNC_0) || (RxPeek(1U) != PC_SYNC_1)))
  {
    RxDrop(1U);
  }
  if (RxCount() < 9U)
  {
    return;
  }
  payload_length = (uint16_t)RxPeek(5U) | ((uint16_t)RxPeek(6U) << 8);
  if ((RxPeek(2U) != PC_PROTOCOL_VERSION) ||
      (payload_length > PC_MAX_COMMAND_DATA))
  {
    RxDrop(2U);
    return;
  }
  frame_length = (uint16_t)(9U + payload_length);
  if (RxCount() < frame_length)
  {
    return;
  }
  for (i = 0U; i < frame_length; i++)
  {
    frame[i] = RxPeek(i);
  }
  received_crc = GetU16(&frame[7U + payload_length]);
  calculated_crc = Crc16(&frame[2], (uint16_t)(5U + payload_length));
  RxDrop(frame_length);
  if (received_crc != calculated_crc)
  {
    SendCommandResult(frame[4], frame[3], false, LA_ERROR_BAD_PACKET);
    return;
  }
  HandleCommand(frame[3], frame[4], &frame[7], payload_length);
}

static void SendStreamBlock(void)
{
  LA_StreamBlock block;
  LA_Status status;
  uint8_t *payload = &tx_buffer[7];

  if (!TxAvailable() || !LA_GetStreamBlock(&block))
  {
    return;
  }
  LA_GetStatus(&status);
  PutU32(&payload[0], block.stream_id);
  PutU32(&payload[4], block.first_sample);
  PutU32(&payload[8], status.actual_rate_hz);
  PutU16(&payload[12], block.count);
  PutU16(&payload[14], status.flags);
  memcpy(&payload[16], block.samples, block.count);
  if (BuildFrame(RSP_STREAM, stream_sequence, payload,
                 (uint16_t)(16U + block.count)))
  {
    stream_sequence++;
    LA_ConsumeStreamBlock();
  }
}

void PC_Init(void)
{
  rx_write = 0U;
  rx_read = 0U;
  rx_overflow = false;
  tx_queued = false;
  tx_in_flight = false;
  usb_was_connected = false;
  stream_sequence = 0U;
}

void PC_USB_Receive(const uint8_t *data, uint16_t length)
{
  uint16_t i;

  for (i = 0U; i < length; i++)
  {
    uint16_t next = (uint16_t)((rx_write + 1U) & (PC_RX_RING_SIZE - 1U));
    if (next == rx_read)
    {
      rx_overflow = true;
      break;
    }
    rx_ring[rx_write] = data[i];
    rx_write = next;
  }
}

void PC_SendStatus(void)
{
  if (TxAvailable())
  {
    SendStatusFrame(0U);
  }
}

void PC_Task(void)
{
  bool connected = UsbConnected();
  LA_Status status;

  ServiceTx();
  if (usb_was_connected && !connected)
  {
    SelfTest_Stop();
    LA_GetStatus(&status);
    if (status.state == LA_STATE_STREAMING)
    {
      LA_Stop();
    }
  }
  usb_was_connected = connected;
  if (!connected)
  {
    return;
  }
  if (rx_overflow)
  {
    rx_overflow = false;
    rx_read = rx_write;
  }
  if (TxAvailable())
  {
    ParseOneCommand();
  }
  if (TxAvailable())
  {
    SendStreamBlock();
  }
  ServiceTx();
}
