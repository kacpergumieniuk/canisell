// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @title Buy/sell round-trip simulator for honeypot + tax detection.
/// @notice NEVER deployed. Its runtime bytecode is injected at a throwaway address through an
///         `eth_call` state override, together with an ETH balance (and optionally a quote-token
///         balance via a storage override). Nothing here ever touches a real transaction.
///
/// Two venues are supported:
///  - V2-style pairs (Uniswap V2 + Aerodrome volatile pools): direct `pair.swap` with the pool's own math.
///  - Uniswap V4 pools: `PoolManager.unlock` + swap/settle/take inside `unlockCallback`.
///
/// Token-level tax is measured as the gap between what the pool says we get / it gets and what
/// balances actually move by. This isolates fee-on-transfer taxes from LP/hook fees, which are
/// reported separately as a round-trip loss computed off-chain.

interface IERC20 {
    function balanceOf(address) external view returns (uint256);
    function transfer(address, uint256) external returns (bool);
}

interface IWETH {
    function deposit() external payable;
}

interface IV2Pair {
    function token0() external view returns (address);
    function getReserves() external view returns (uint256 r0, uint256 r1, uint256 ts);
    function swap(uint256 amount0Out, uint256 amount1Out, address to, bytes calldata data) external;
}

interface IAeroPool {
    function getAmountOut(uint256 amountIn, address tokenIn) external view returns (uint256);
}

struct PoolKey {
    address currency0;
    address currency1;
    uint24 fee;
    int24 tickSpacing;
    address hooks;
}

struct SwapParams {
    bool zeroForOne;
    int256 amountSpecified;
    uint160 sqrtPriceLimitX96;
}

interface IPoolManager {
    function unlock(bytes calldata data) external returns (bytes memory);
    function swap(PoolKey memory key, SwapParams memory params, bytes calldata hookData) external returns (int256);
    function sync(address currency) external;
    function settle() external payable returns (uint256);
    function take(address currency, address to, uint256 amount) external;
}

contract Simulator {
    address constant WETH = 0x4200000000000000000000000000000000000006;
    address constant POOL_MANAGER = 0x498581fF718922c3f8e6A244956aF099B2652b2b;
    uint160 constant MIN_SQRT_PRICE_PLUS_ONE = 4295128740;
    uint160 constant MAX_SQRT_PRICE_MINUS_ONE = 1461446703485210103287273052203988822378723970341;
    address constant TRANSFER_PROBE = 0x000000000000000000000000000000000000bEEF;

    struct Result {
        bool buyOk;
        bool sellOk;
        bool transferOk;
        uint256 quoteIn;         // quote spent on buy
        uint256 buyExpected;     // tokens the pool says we bought
        uint256 buyReceived;     // tokens our balance actually increased by
        uint256 sellAmount;      // tokens we sent to sell
        uint256 sellAccepted;    // tokens the pool actually received / credited
        uint256 sellExpected;    // quote we would get for sellAmount with zero token tax
        uint256 sellReceived;    // quote our balance actually increased by
        uint256 transferSent;
        uint256 transferReceived;
        uint256 buyGas;
        uint256 sellGas;
        bytes buyError;
        bytes sellError;
    }

    receive() external payable {}

    // ------------------------------------------------------------------ helpers

    function _bal(address currency, address who) internal view returns (uint256) {
        if (currency == address(0)) return who.balance;
        return IERC20(currency).balanceOf(who);
    }

    function _xfer(address token, address to, uint256 amount) internal {
        (bool ok, bytes memory ret) = token.call(abi.encodeWithSelector(IERC20.transfer.selector, to, amount));
        if (!ok) {
            assembly {
                revert(add(ret, 32), mload(ret))
            }
        }
        require(ret.length == 0 || abi.decode(ret, (bool)), "transfer returned false");
    }

    /// @dev Moves 10% of the held tokens to a probe address to measure plain wallet-to-wallet tax.
    function _probeTransfer(address token, Result memory r) internal {
        uint256 held = IERC20(token).balanceOf(address(this));
        uint256 amt = held / 10;
        if (amt == 0) return;
        uint256 before = IERC20(token).balanceOf(TRANSFER_PROBE);
        try this.externalTransfer(token, TRANSFER_PROBE, amt) {
            r.transferOk = true;
            r.transferSent = amt;
            r.transferReceived = IERC20(token).balanceOf(TRANSFER_PROBE) - before;
        } catch {}
    }

    function externalTransfer(address token, address to, uint256 amount) external {
        require(msg.sender == address(this), "self only");
        _xfer(token, to, amount);
    }

    // ------------------------------------------------------------------ V2

    function _v2Out(address pair, bool aero, address tokenIn, uint256 amountIn, uint256 rIn, uint256 rOut)
        internal
        view
        returns (uint256)
    {
        if (aero) return IAeroPool(pair).getAmountOut(amountIn, tokenIn);
        uint256 inWithFee = amountIn * 997;
        return (inWithFee * rOut) / (rIn * 1000 + inWithFee);
    }

    /// @param quote ERC20 quote token (WETH is wrapped from this contract's ETH balance).
    function simulateV2(address pair, address token, address quote, uint256 amountIn, bool aero)
        external
        returns (Result memory r)
    {
        if (quote == WETH) IWETH(WETH).deposit{value: amountIn}();
        r.quoteIn = amountIn;
        bool tokenIs0 = IV2Pair(pair).token0() == token;

        // BUY
        uint256 g = gasleft();
        try this.v2Buy(pair, token, quote, amountIn, aero, tokenIs0) returns (uint256 expected, uint256 received) {
            r.buyOk = true;
            r.buyExpected = expected;
            r.buyReceived = received;
        } catch (bytes memory err) {
            r.buyError = err;
            return r;
        }
        r.buyGas = g - gasleft();

        _probeTransfer(token, r);

        // SELL everything we still hold
        r.sellAmount = IERC20(token).balanceOf(address(this));
        g = gasleft();
        try this.v2Sell(pair, token, quote, r.sellAmount, aero, tokenIs0) returns (
            uint256 accepted, uint256 expected, uint256 received
        ) {
            r.sellOk = true;
            r.sellAccepted = accepted;
            r.sellExpected = expected;
            r.sellReceived = received;
        } catch (bytes memory err) {
            r.sellError = err;
        }
        r.sellGas = g - gasleft();
    }

    function v2Buy(address pair, address token, address quote, uint256 amountIn, bool aero, bool tokenIs0)
        external
        returns (uint256 expected, uint256 received)
    {
        require(msg.sender == address(this), "self only");
        (uint256 r0, uint256 r1,) = IV2Pair(pair).getReserves();
        (uint256 rQ, uint256 rT) = tokenIs0 ? (r1, r0) : (r0, r1);
        expected = _v2Out(pair, aero, quote, amountIn, rQ, rT);
        uint256 before = IERC20(token).balanceOf(address(this));
        _xfer(quote, pair, amountIn);
        if (tokenIs0) IV2Pair(pair).swap(expected, 0, address(this), "");
        else IV2Pair(pair).swap(0, expected, address(this), "");
        received = IERC20(token).balanceOf(address(this)) - before;
    }

    function v2Sell(address pair, address token, address quote, uint256 amount, bool aero, bool tokenIs0)
        external
        returns (uint256 accepted, uint256 expected, uint256 received)
    {
        require(msg.sender == address(this), "self only");
        _xfer(token, pair, amount);
        // Read reserves AFTER the transfer: tax tokens often swap their fee balance back into this
        // same pair inside transfer(), which moves reserves.
        (uint256 r0, uint256 r1,) = IV2Pair(pair).getReserves();
        (uint256 rQ, uint256 rT) = tokenIs0 ? (r1, r0) : (r0, r1);
        accepted = IERC20(token).balanceOf(pair) - rT;
        expected = _v2Out(pair, aero, token, amount, rT, rQ);
        uint256 out = _v2Out(pair, aero, token, accepted, rT, rQ);
        uint256 before = IERC20(quote).balanceOf(address(this));
        if (tokenIs0) IV2Pair(pair).swap(0, out, address(this), "");
        else IV2Pair(pair).swap(out, 0, address(this), "");
        received = IERC20(quote).balanceOf(address(this)) - before;
    }

    // ------------------------------------------------------------------ V4

    struct V4Ctx {
        PoolKey key;
        bool buy;            // true: quote -> token, false: token -> quote
        bool tokenIs1;
        uint256 amount;      // exact input amount
    }

    /// @notice quote may be address(0) (native ETH) or an ERC20 (WETH is wrapped from ETH balance;
    ///         any other ERC20 must be pre-funded via a storage override).
    function simulateV4(PoolKey calldata key, bool tokenIs1, uint256 amountIn) external returns (Result memory r) {
        address token = tokenIs1 ? key.currency1 : key.currency0;
        address quote = tokenIs1 ? key.currency0 : key.currency1;
        if (quote == WETH) IWETH(WETH).deposit{value: amountIn}();
        r.quoteIn = amountIn;

        uint256 g = gasleft();
        uint256 before = IERC20(token).balanceOf(address(this));
        try IPoolManager(POOL_MANAGER).unlock(abi.encode(V4Ctx(key, true, tokenIs1, amountIn))) returns (bytes memory ret) {
            (, uint256 expected) = abi.decode(ret, (uint256, uint256));
            r.buyOk = true;
            r.buyExpected = expected;
            r.buyReceived = IERC20(token).balanceOf(address(this)) - before;
        } catch (bytes memory err) {
            r.buyError = err;
            return r;
        }
        r.buyGas = g - gasleft();

        _probeTransfer(token, r);

        r.sellAmount = IERC20(token).balanceOf(address(this));
        uint256 qBefore = _bal(quote, address(this));
        g = gasleft();
        try IPoolManager(POOL_MANAGER).unlock(abi.encode(V4Ctx(key, false, tokenIs1, r.sellAmount))) returns (bytes memory ret) {
            (uint256 accepted, uint256 expected) = abi.decode(ret, (uint256, uint256));
            r.sellOk = true;
            r.sellAccepted = accepted;
            r.sellExpected = expected; // pool output for the accepted amount (tax-adjusted off-chain)
            r.sellReceived = _bal(quote, address(this)) - qBefore;
        } catch (bytes memory err) {
            r.sellError = err;
        }
        r.sellGas = g - gasleft();
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        require(msg.sender == POOL_MANAGER, "pm only");
        V4Ctx memory c = abi.decode(data, (V4Ctx));
        address token = c.tokenIs1 ? c.key.currency1 : c.key.currency0;
        address quote = c.tokenIs1 ? c.key.currency0 : c.key.currency1;
        address payIn = c.buy ? quote : token;
        address takeOut = c.buy ? token : quote;
        IPoolManager pm = IPoolManager(POOL_MANAGER);

        // Pay first so we learn how much the PoolManager actually credits (fee-on-transfer aware).
        uint256 paid;
        if (payIn == address(0)) {
            paid = pm.settle{value: c.amount}();
        } else {
            pm.sync(payIn);
            _xfer(payIn, POOL_MANAGER, c.amount);
            paid = pm.settle();
        }

        // zeroForOne when paying currency0
        bool zeroForOne = payIn == c.key.currency0;
        int256 delta = pm.swap(
            c.key,
            SwapParams({
                zeroForOne: zeroForOne,
                amountSpecified: -int256(paid),
                sqrtPriceLimitX96: zeroForOne ? MIN_SQRT_PRICE_PLUS_ONE : MAX_SQRT_PRICE_MINUS_ONE
            }),
            ""
        );
        int128 a0 = int128(delta >> 128);
        int128 a1 = int128(delta);
        int128 outDelta = zeroForOne ? a1 : a0;
        int128 inDelta = zeroForOne ? a0 : a1;
        require(outDelta > 0, "no output");
        uint256 out = uint256(uint128(outDelta));
        // exact-input swaps may leave part of the input unspent (price limit hit); take it back
        uint256 spent = uint256(uint128(-inDelta));
        if (spent < paid) pm.take(payIn, address(this), paid - spent);
        pm.take(takeOut, address(this), out);
        return abi.encode(paid, out);
    }
}
