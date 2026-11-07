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
  uint16_t crc = 0xFFFFU;
  uint16_t i;
  uint8_t bit;

  for (i = 0U; i < length; i++)
  {
    crc ^= (uint16_t)data[i] << 8;
    for (bit = 0U; bit < 8U; bit++)
    {
      crc = (crc & 0x8000U) ? (uint16_t)((crc << 1) ^ 0x1021U) :
                              (uint16_t)(crc << 1);
    }
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
    1U, 3U,             /* firmware 1.3: self-test dung rate an toan */
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
  (void)BuildFrame(RSP_STREAM, stream_sequence++, payload,
                   (uint16_t)(16U + block.count));
  LA_ConsumeStreamBlock();
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
