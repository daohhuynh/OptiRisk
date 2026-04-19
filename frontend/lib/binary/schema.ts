// Wire protocol constants — mirrors wire_protocol.hpp exactly
// All values little-endian (x86-64 native)

export enum MsgType {
  ShockPayload = 0x01,
  TickDelta = 0x02,
  NodeSnapshot = 0x03,
  MarketAnchors = 0x04,
  CreditRevoke = 0x05,
  ShortOrder = 0x06,
  VaRReport = 0x07,
  BboChange = 0x08,
  SystemReset = 0x09,
  VaRRequest = 0x0A,
  Heartbeat = 0xFE,
  Error = 0xFF,
}

export const MSG_HEADER_SIZE = 4;
export const TICK_DELTA_SIZE = 56;
export const NODE_SNAPSHOT_SIZE = 28;
export const MARKET_ANCHORS_SIZE = 40;
export const VAR_REPORT_SIZE = 56;  // Fixed: Back to 56 for L1 Cache Alignment
export const SHOCK_PAYLOAD_SIZE = 56;
export const CREDIT_REVOKE_SIZE = 16;
export const SHORT_ORDER_SIZE = 24;
export const SHOCK_PACKET_SIZE = MSG_HEADER_SIZE + SHOCK_PAYLOAD_SIZE;

// ShockType enum values (match C++ wire_protocol.hpp)
export enum ShockTypeWire {
  Custom = 0,
  Lehman2008 = 1,
  Covid2020 = 2,
  RateHike = 3,
  CryptoCrash = 4,
}

export const HUB_NAMES = ['NYC', 'London', 'Tokyo', 'HongKong', 'Dubai'] as const;
