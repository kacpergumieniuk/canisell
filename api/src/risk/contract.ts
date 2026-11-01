import { getAddress, parseAbi, size, type Address, type Hex, type PublicClient } from "viem";
import { BURN_ADDRESSES } from "../chain/addresses.ts";
import { detectCapabilities, detectMinimalProxy, extractPush4Selectors } from "./bytecode.ts";
import type { ContractFacts } from "./types.ts";

export const ERC20_ABI = parseAbi([
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function totalSupply() view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
]);

const OWNER_ABI = parseAbi([
  "function owner() view returns (address)",
  "function getOwner() view returns (address)",
  "function admin() view returns (address)",
]);

export const SLOTS = {
  eip1967Impl: "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc",
  eip1967Admin: "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103",
  eip1967Beacon: "0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50",
  zeppelinosImpl: "0x7050c9e0f4ca769c69bd3a8ef740bc37934f8e2c036e5a723fd8ee048ed3f8c3",
} as const;

function slotToAddress(v: Hex | undefined): Address | undefined {
  if (!v || BigInt(v) === 0n) return undefined;
  return getAddress("0x" + v.slice(-40));
}

async function tryRead<T>(p: Promise<T>): Promise<T | undefined> {
  try {
    return await p;
  } catch {
    return undefined;
  }
}

export async function inspectContract(client: PublicClient, token: Address): Promise<ContractFacts> {
  const code = (await client.getCode({ address: token })) ?? "0x";
  const facts: ContractFacts = {
    isContract: code !== "0x",
    codeSize: code === "0x" ? 0 : size(code),
    renounced: false,
    proxy: { kind: "none" },
    capabilities: {},
  };
  if (!facts.isContract) return facts;

  const read = <T>(abi: any, functionName: string) =>
    tryRead(client.readContract({ address: token, abi, functionName }) as Promise<T>);
  const slot = (s: Hex) => tryRead(client.getStorageAt({ address: token, slot: s }));

  const [name, symbol, decimals, totalSupply, owner, getOwner, admin, impl, adminSlot, beacon, zos] =
    await Promise.all([
      read<string>(ERC20_ABI, "name"),
      read<string>(ERC20_ABI, "symbol"),
      read<number>(ERC20_ABI, "decimals"),
      read<bigint>(ERC20_ABI, "totalSupply"),
      read<Address>(OWNER_ABI, "owner"),
      read<Address>(OWNER_ABI, "getOwner"),
      read<Address>(OWNER_ABI, "admin"),
      slot(SLOTS.eip1967Impl),
      slot(SLOTS.eip1967Admin),
      slot(SLOTS.eip1967Beacon),
      slot(SLOTS.zeppelinosImpl),
    ]);
  Object.assign(facts, { name, symbol, decimals: decimals === undefined ? undefined : Number(decimals), totalSupply });

  const ownerPick: [Address | undefined, string][] = [
    [owner, "owner()"],
    [getOwner, "getOwner()"],
    [admin, "admin()"],
  ];
  const hit = ownerPick.find(([a]) => a !== undefined);
  if (hit) {
    facts.owner = getAddress(hit[0]!);
    facts.ownerSource = hit[1];
    facts.renounced = BURN_ADDRESSES.has(facts.owner.toLowerCase());
  } else {
    // No owner getter at all: no Ownable-style admin is exposed.
    facts.renounced = true;
    facts.ownerSource = "none";
  }

  // Proxy detection. Upgradeable proxies get their implementation scanned too.
  let scanCode: Hex = code;
  const clone = detectMinimalProxy(code);
  const implAddr = slotToAddress(impl);
  const beaconAddr = slotToAddress(beacon);
  const zosAddr = slotToAddress(zos);
  if (clone) {
    facts.proxy = { kind: "eip1167-clone", implementation: clone };
  } else if (implAddr) {
    facts.proxy = { kind: "eip1967", implementation: implAddr, admin: slotToAddress(adminSlot) };
  } else if (beaconAddr) {
    const beaconImpl = await tryRead(
      client.readContract({
        address: beaconAddr,
        abi: parseAbi(["function implementation() view returns (address)"]),
        functionName: "implementation",
      }),
    );
    facts.proxy = { kind: "eip1967-beacon", implementation: beaconImpl, admin: beaconAddr };
  } else if (zosAddr) {
    facts.proxy = { kind: "zeppelinos", implementation: zosAddr };
  }
  if (facts.proxy.implementation) {
    const implCode = await tryRead(client.getCode({ address: facts.proxy.implementation }));
    if (implCode && implCode !== "0x") scanCode = facts.proxy.kind === "eip1167-clone" ? implCode : (`${code}${implCode.slice(2)}` as Hex);
  }

  facts.capabilities = detectCapabilities(extractPush4Selectors(scanCode));
  return facts;
}
