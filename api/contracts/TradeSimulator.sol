// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @title TradeSimulator
/// @notice Never deployed. Its runtime bytecode is injected with an eth_call state override
///         and executed as a read-only simulation of "buy a small amount, then sell all of it".
///         It holds no funds and has no owner; every path ends in a revert or a view result.
///         Compile with `npm run build:sim` (writes src/sim/bytecode.ts).

interface IERC20Min {
    function balanceOf(address) external view returns (uint256);
}

interface IWETH {
    function deposit() external payable;
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

interface IUniV2Pair {
    function getReserves() external view returns (uint112, uint112, uint32);
    function swap(uint256 amount0Out, uint256 amount1Out, address to, bytes calldata data) external;
    function token0() external view returns (address);
}

interface IAeroPool {
    function getAmountOut(uint256 amountIn, address tokenIn) external view returns (uint256);
}

interface IUniV3Pool {
    function swap(address recipient, bool zeroForOne, int256 amountSpecified, uint160 sqrtPriceLimitX96, bytes calldata data)
        external
        returns (int256, int256);
    function token0() external view returns (address);
}

contract TradeSimulator {
    /// Stages: 0 = full round trip ok, 1 = buy swap reverted, 2 = receiving bought tokens reverted,
    /// 3 = sending tokens back (sell transfer) reverted, 4 = sell swap reverted, 5 = setup failed.
    struct Result {
        uint8 stage;
        uint256 quoteIn;
        uint256 buyExpected;
        uint256 buyReceived;
        uint256 sellSent;
        uint256 sellArrived;
        uint256 quoteOut;
        uint256 buyGas;
        uint256 sellGas;
        bytes revertData;
    }

    error SimDone(Result r);
    error DepthDone(uint256 quoteOut);

    uint160 internal constant MIN_SQRT_PRICE_PLUS_ONE = 4295128740;
    uint160 internal constant MAX_SQRT_PRICE_MINUS_ONE = 1461446703485210103287273052203988822378723970341;

    // transient-ish scratch (we are always called via eth_call, storage writes are discarded)
    address internal pm;
    address internal v3Pay;

    receive() external payable {}

    // ------------------------------------------------------------------ Uniswap v4

    function simV4(address poolManager, PoolKey calldata key, bool tokenIsCurrency0, uint256 amountIn)
        external
        returns (Result memory r)
    {
        pm = poolManager;
        try IPoolManager(poolManager).unlock(abi.encode(uint8(1), key, tokenIsCurrency0, amountIn)) {
            r.stage = 5;
        } catch (bytes memory err) {
            if (err.length >= 4 && bytes4(err) == SimDone.selector) {
                bytes memory payload = new bytes(err.length - 4);
                for (uint256 i = 0; i < payload.length; i++) payload[i] = err[i + 4];
                r = abi.decode(payload, (Result));
            } else {
                r.stage = 5;
                r.revertData = err;
            }
        }
    }

    /// @notice Quote obtainable by selling `tokenAmount` (e.g. the whole supply) into the pool:
    ///         an upper bound of the real quote-side liquidity ("exit liquidity").
    function depthV4(address poolManager, PoolKey calldata key, bool tokenIsCurrency0, uint256 tokenAmount)
        external
        returns (uint256 quoteOut, bytes memory revertData)
    {
        pm = poolManager;
        try IPoolManager(poolManager).unlock(abi.encode(uint8(2), key, tokenIsCurrency0, tokenAmount)) {}
        catch (bytes memory err) {
            if (err.length == 36 && bytes4(err) == DepthDone.selector) {
                bytes memory payload = new bytes(32);
                for (uint256 i = 0; i < 32; i++) payload[i] = err[i + 4];
                quoteOut = abi.decode(payload, (uint256));
            } else {
                revertData = err;
            }
        }
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        require(msg.sender == pm, "only pm");
        (uint8 mode, PoolKey memory key, bool tokenIs0, uint256 amountIn) =
            abi.decode(data, (uint8, PoolKey, bool, uint256));
        IPoolManager m = IPoolManager(pm);
        if (mode == 2) {
            int256 d = m.swap(
                key,
                SwapParams(tokenIs0, -int256(amountIn), tokenIs0 ? MIN_SQRT_PRICE_PLUS_ONE : MAX_SQRT_PRICE_MINUS_ONE),
                ""
            );
            int128 q = tokenIs0 ? int128(d) : int128(d >> 128);
            revert DepthDone(q > 0 ? uint256(int256(q)) : 0);
        }
        address token = tokenIs0 ? key.currency0 : key.currency1;
        Result memory r;
        r.quoteIn = amountIn;

        // 1. buy: quote -> token, exact input. We never pay the quote side: the whole unlock reverts at the end.
        bool buyZeroForOne = !tokenIs0;
        uint256 g = gasleft();
        try m.swap(
            key,
            SwapParams(buyZeroForOne, -int256(amountIn), buyZeroForOne ? MIN_SQRT_PRICE_PLUS_ONE : MAX_SQRT_PRICE_MINUS_ONE),
            ""
        ) returns (int256 delta) {
            r.buyGas = g - gasleft();
            int128 tokenDelta = tokenIs0 ? int128(delta >> 128) : int128(delta);
            if (tokenDelta <= 0) {
                r.stage = 1;
                revert SimDone(r);
            }
            r.buyExpected = uint256(int256(tokenDelta));
        } catch (bytes memory err) {
            r.stage = 1;
            r.revertData = err;
            revert SimDone(r);
        }

        // 2. receive the tokens (real ERC20 transfer from the PoolManager to us)
        uint256 before = IERC20Min(token).balanceOf(address(this));
        try m.take(token, address(this), r.buyExpected) {}
        catch (bytes memory err) {
            r.stage = 2;
            r.revertData = err;
            revert SimDone(r);
        }
        r.buyReceived = IERC20Min(token).balanceOf(address(this)) - before;
        if (r.buyReceived == 0) {
            r.stage = 2;
            revert SimDone(r);
        }

        // 3. send everything back (real ERC20 transfer to the PoolManager) and settle
        r.sellSent = r.buyReceived;
        m.sync(token);
        (bool ok, bytes memory ret) = token.call(abi.encodeWithSignature("transfer(address,uint256)", pm, r.sellSent));
        if (!ok || (ret.length > 0 && !abi.decode(ret, (bool)))) {
            r.stage = 3;
            r.revertData = ret;
            revert SimDone(r);
        }
        try m.settle() returns (uint256 paid) {
            r.sellArrived = paid;
        } catch (bytes memory err) {
            r.stage = 3;
            r.revertData = err;
            revert SimDone(r);
        }

        // 4. sell: token -> quote, exact input of what actually arrived
        bool sellZeroForOne = tokenIs0;
        g = gasleft();
        try m.swap(
            key,
            SwapParams(
                sellZeroForOne, -int256(r.sellArrived), sellZeroForOne ? MIN_SQRT_PRICE_PLUS_ONE : MAX_SQRT_PRICE_MINUS_ONE
            ),
            ""
        ) returns (int256 delta) {
            r.sellGas = g - gasleft();
            int128 quoteDelta = tokenIs0 ? int128(delta) : int128(delta >> 128);
            r.quoteOut = quoteDelta > 0 ? uint256(int256(quoteDelta)) : 0;
        } catch (bytes memory err) {
            r.stage = 4;
            r.revertData = err;
            revert SimDone(r);
        }
        revert SimDone(r);
    }

    // ------------------------------------------------------------------ Uniswap v2 / Aerodrome v2 (WETH-quoted)

    function simV2(address pair, address token, address weth, uint256 amountIn, bool aero)
        external
        returns (Result memory r)
    {
        r.quoteIn = amountIn;
        IWETH(weth).deposit{value: amountIn}();
        bool tokenIs0 = IUniV2Pair(pair).token0() == token;

        // buy
        uint256 out = _v2Out(pair, weth, amountIn, !tokenIs0, aero);
        r.buyExpected = out;
        if (!_safeTransfer(weth, pair, amountIn)) {
            r.stage = 5;
            return r;
        }
        uint256 before = IERC20Min(token).balanceOf(address(this));
        uint256 g = gasleft();
        try IUniV2Pair(pair).swap(tokenIs0 ? out : 0, tokenIs0 ? 0 : out, address(this), "") {
            r.buyGas = g - gasleft();
        } catch (bytes memory err) {
            r.stage = 1;
            r.revertData = err;
            return r;
        }
        r.buyReceived = IERC20Min(token).balanceOf(address(this)) - before;
        if (r.buyReceived == 0) {
            r.stage = 2;
            return r;
        }

        // sell
        r.sellSent = r.buyReceived;
        uint256 pairBefore = IERC20Min(token).balanceOf(pair);
        (bool ok, bytes memory ret) =
            token.call(abi.encodeWithSignature("transfer(address,uint256)", pair, r.sellSent));
        if (!ok || (ret.length > 0 && !abi.decode(ret, (bool)))) {
            r.stage = 3;
            r.revertData = ret;
            return r;
        }
        r.sellArrived = IERC20Min(token).balanceOf(pair) - pairBefore;
        uint256 qOut = _v2Out(pair, token, r.sellArrived, tokenIs0, aero);
        uint256 wBefore = IERC20Min(weth).balanceOf(address(this));
        g = gasleft();
        try IUniV2Pair(pair).swap(tokenIs0 ? 0 : qOut, tokenIs0 ? qOut : 0, address(this), "") {
            r.sellGas = g - gasleft();
        } catch (bytes memory err) {
            r.stage = 4;
            r.revertData = err;
            return r;
        }
        r.quoteOut = IERC20Min(weth).balanceOf(address(this)) - wBefore;
    }

    function _v2Out(address pair, address tokenIn, uint256 amountIn, bool inIs0, bool aero) internal view returns (uint256) {
        if (aero) return IAeroPool(pair).getAmountOut(amountIn, tokenIn);
        (uint112 r0, uint112 r1,) = IUniV2Pair(pair).getReserves();
        (uint256 rin, uint256 rout) = inIs0 ? (uint256(r0), uint256(r1)) : (uint256(r1), uint256(r0));
        uint256 inWithFee = amountIn * 997;
        return (inWithFee * rout) / (rin * 1000 + inWithFee);
    }

    // ------------------------------------------------------------------ Uniswap v3 (WETH-quoted)

    function simV3(address pool, address token, address weth, uint256 amountIn) external returns (Result memory r) {
        r.quoteIn = amountIn;
        IWETH(weth).deposit{value: amountIn}();
        bool tokenIs0 = IUniV3Pool(pool).token0() == token;
        v3Pay = pool;

        // buy: weth -> token
        bool zf1 = !tokenIs0;
        uint256 before = IERC20Min(token).balanceOf(address(this));
        uint256 g = gasleft();
        try IUniV3Pool(pool).swap(
            address(this), zf1, int256(amountIn), zf1 ? MIN_SQRT_PRICE_PLUS_ONE : MAX_SQRT_PRICE_MINUS_ONE, abi.encode(weth)
        ) returns (int256 a0, int256 a1) {
            r.buyGas = g - gasleft();
            int256 t = tokenIs0 ? a0 : a1;
            r.buyExpected = t < 0 ? uint256(-t) : 0;
        } catch (bytes memory err) {
            r.stage = 1;
            r.revertData = err;
            return r;
        }
        r.buyReceived = IERC20Min(token).balanceOf(address(this)) - before;
        if (r.buyReceived == 0) {
            r.stage = 2;
            return r;
        }

        // sell: token -> weth
        r.sellSent = r.buyReceived;
        uint256 poolBefore = IERC20Min(token).balanceOf(pool);
        uint256 wBefore = IERC20Min(weth).balanceOf(address(this));
        g = gasleft();
        try IUniV3Pool(pool).swap(
            address(this), tokenIs0, int256(r.sellSent), tokenIs0 ? MIN_SQRT_PRICE_PLUS_ONE : MAX_SQRT_PRICE_MINUS_ONE, abi.encode(token)
        ) {
            r.sellGas = g - gasleft();
        } catch (bytes memory err) {
            // v3 pools revert ("IIA") when a fee-on-transfer token delivers less than owed
            r.stage = 4;
            r.revertData = err;
            return r;
        }
        r.sellArrived = IERC20Min(token).balanceOf(pool) - poolBefore;
        r.quoteOut = IERC20Min(weth).balanceOf(address(this)) - wBefore;
    }

    function uniswapV3SwapCallback(int256 a0, int256 a1, bytes calldata data) external {
        require(msg.sender == v3Pay, "only pool");
        address payToken = abi.decode(data, (address));
        uint256 owed = uint256(a0 > 0 ? a0 : a1);
        require(_safeTransfer(payToken, msg.sender, owed), "pay failed");
    }

    function _safeTransfer(address token, address to, uint256 amount) internal returns (bool) {
        (bool ok, bytes memory ret) = token.call(abi.encodeWithSignature("transfer(address,uint256)", to, amount));
        return ok && (ret.length == 0 || abi.decode(ret, (bool)));
    }
}
