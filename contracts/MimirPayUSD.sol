// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/**
 * MimirPayUSD — the asset x402 payments settle in on Somnia Shannon.
 *
 * ── Why this exists ──────────────────────────────────────────────────────────
 *
 * x402's `exact` scheme pays by signature: the buyer signs an authorization, the
 * seller hands it to a facilitator, and the facilitator moves the tokens. That
 * needs a token that can be moved by a signature. The venue's collateral cannot:
 * it is a plain ERC-20 with no EIP-3009, no EIP-2612 permit, and no EIP-712
 * domain, and Permit2 is not deployed on this chain either. So every paid route
 * failed to initialise and x402 revenue was structurally zero.
 *
 * This is the smallest token that closes that gap: an ERC-20 with EIP-3009
 * authorized transfers. It is deliberately NOT the trading collateral —
 * positions stay denominated in what the venue settles, and payments for
 * services are their own asset.
 *
 * ── What EIP-3009 buys ───────────────────────────────────────────────────────
 *
 * `transferWithAuthorization` moves tokens on the strength of a signature from
 * the holder, submitted by anyone. The facilitator therefore pays the gas and
 * the buyer never sends a transaction — which is the whole point of an agent
 * paying a fraction of a cent for a read.
 *
 * Each authorization carries its own nonce, and a used nonce can never be
 * replayed. The nonce is chosen by the signer rather than being sequential, so
 * concurrent authorizations from one wallet do not have to queue.
 *
 * `receiveWithAuthorization` is the same transfer with one extra rule: only the
 * payee may submit it. That closes the front-running window where somebody else
 * broadcasts an authorization they saw in the mempool and steers the recipient's
 * own contract logic.
 */
contract MimirPayUSD {
    // ── ERC-20 ────────────────────────────────────────────────────────────────
    string public constant name     = "Mimir Pay USD";
    string public constant symbol   = "mpUSD";
    /** Six, to match the venue's collateral and every price string in the app. */
    uint8  public constant decimals = 6;

    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    // ── Minting ───────────────────────────────────────────────────────────────
    address public minter;

    event MinterChanged(address indexed previous, address indexed next);

    // ── EIP-3009 ──────────────────────────────────────────────────────────────
    bytes32 public constant TRANSFER_WITH_AUTHORIZATION_TYPEHASH = keccak256(
        "TransferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)"
    );
    bytes32 public constant RECEIVE_WITH_AUTHORIZATION_TYPEHASH = keccak256(
        "ReceiveWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)"
    );
    bytes32 public constant CANCEL_AUTHORIZATION_TYPEHASH = keccak256(
        "CancelAuthorization(address authorizer,bytes32 nonce)"
    );

    /** Per-authorizer nonce set. A nonce is single-use, never sequential. */
    mapping(address => mapping(bytes32 => bool)) public authorizationState;

    event AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce);
    event AuthorizationCanceled(address indexed authorizer, bytes32 indexed nonce);

    bytes32 private immutable _cachedDomainSeparator;
    uint256 private immutable _cachedChainId;

    constructor(address _minter) {
        require(_minter != address(0), "mpUSD: zero minter");
        minter = _minter;
        _cachedChainId = block.chainid;
        _cachedDomainSeparator = _buildDomainSeparator();
        emit MinterChanged(address(0), _minter);
    }

    // ── EIP-712 ───────────────────────────────────────────────────────────────

    function _buildDomainSeparator() private view returns (bytes32) {
        return keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256(bytes(name)),
                keccak256(bytes("1")),
                block.chainid,
                address(this)
            )
        );
    }

    /**
     * Rebuilt when the chain id has changed under us, so a fork cannot replay
     * signatures that were only ever meant for the original chain.
     */
    function DOMAIN_SEPARATOR() public view returns (bytes32) {
        return block.chainid == _cachedChainId ? _cachedDomainSeparator : _buildDomainSeparator();
    }

    // ── ERC-20 ────────────────────────────────────────────────────────────────

    function transfer(address to, uint256 value) external returns (bool) {
        _transfer(msg.sender, to, value);
        return true;
    }

    function approve(address spender, uint256 value) external returns (bool) {
        allowance[msg.sender][spender] = value;
        emit Approval(msg.sender, spender, value);
        return true;
    }

    function transferFrom(address from, address to, uint256 value) external returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        if (allowed != type(uint256).max) {
            require(allowed >= value, "mpUSD: insufficient allowance");
            unchecked { allowance[from][msg.sender] = allowed - value; }
        }
        _transfer(from, to, value);
        return true;
    }

    function _transfer(address from, address to, uint256 value) private {
        require(to != address(0), "mpUSD: transfer to zero");
        uint256 balance = balanceOf[from];
        require(balance >= value, "mpUSD: insufficient balance");
        unchecked {
            balanceOf[from] = balance - value;
            balanceOf[to] += value;
        }
        emit Transfer(from, to, value);
    }

    // ── Minting ───────────────────────────────────────────────────────────────

    function mint(address to, uint256 value) external {
        require(msg.sender == minter, "mpUSD: not minter");
        require(to != address(0), "mpUSD: mint to zero");
        totalSupply += value;
        unchecked { balanceOf[to] += value; }
        emit Transfer(address(0), to, value);
    }

    function setMinter(address next) external {
        require(msg.sender == minter, "mpUSD: not minter");
        require(next != address(0), "mpUSD: zero minter");
        emit MinterChanged(minter, next);
        minter = next;
    }

    // ── EIP-3009 ──────────────────────────────────────────────────────────────

    function transferWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external {
        _requireValidAuthorization(from, nonce, validAfter, validBefore);
        _requireValidSignature(
            from,
            keccak256(
                abi.encode(
                    TRANSFER_WITH_AUTHORIZATION_TYPEHASH, from, to, value, validAfter, validBefore, nonce
                )
            ),
            v, r, s
        );
        _markAuthorizationUsed(from, nonce);
        _transfer(from, to, value);
    }

    /**
     * As above, but only the payee may submit it.
     *
     * An authorization sitting in the mempool is a signed instruction anyone can
     * broadcast. When the recipient is a contract that reacts to being paid,
     * that hands a stranger the timing. Binding the submitter to the payee
     * removes the choice.
     */
    function receiveWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external {
        require(to == msg.sender, "mpUSD: caller must be the payee");
        _requireValidAuthorization(from, nonce, validAfter, validBefore);
        _requireValidSignature(
            from,
            keccak256(
                abi.encode(
                    RECEIVE_WITH_AUTHORIZATION_TYPEHASH, from, to, value, validAfter, validBefore, nonce
                )
            ),
            v, r, s
        );
        _markAuthorizationUsed(from, nonce);
        _transfer(from, to, value);
    }

    /** Burn an unused nonce, so a signature that leaked can never be spent. */
    function cancelAuthorization(
        address authorizer,
        bytes32 nonce,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external {
        require(!authorizationState[authorizer][nonce], "mpUSD: authorization used");
        _requireValidSignature(
            authorizer,
            keccak256(abi.encode(CANCEL_AUTHORIZATION_TYPEHASH, authorizer, nonce)),
            v, r, s
        );
        authorizationState[authorizer][nonce] = true;
        emit AuthorizationCanceled(authorizer, nonce);
    }

    function _requireValidAuthorization(
        address authorizer,
        bytes32 nonce,
        uint256 validAfter,
        uint256 validBefore
    ) private view {
        require(block.timestamp > validAfter, "mpUSD: authorization not yet valid");
        require(block.timestamp < validBefore, "mpUSD: authorization expired");
        require(!authorizationState[authorizer][nonce], "mpUSD: authorization used");
    }

    function _markAuthorizationUsed(address authorizer, bytes32 nonce) private {
        authorizationState[authorizer][nonce] = true;
        emit AuthorizationUsed(authorizer, nonce);
    }

    function _requireValidSignature(
        address signer,
        bytes32 structHash,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) private view {
        // Reject the upper half of the curve order: for every valid signature an
        // equally valid mirror exists, and accepting both makes a signature a
        // malleable identifier rather than a unique one.
        require(
            uint256(s) <= 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0,
            "mpUSD: malleable signature"
        );
        require(v == 27 || v == 28, "mpUSD: bad signature v");

        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR(), structHash));
        address recovered = ecrecover(digest, v, r, s);
        require(recovered != address(0) && recovered == signer, "mpUSD: invalid signature");
    }
}
