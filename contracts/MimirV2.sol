// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/**
 * Minimal ERC-20 interface used by Mimir for stake custody.
 */
interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

/**
 * Mimir v2 — AI-settled prediction market on Base, with fees.
 *
 * Stakes are held in USDC (ERC-20, 6 decimals). Gas is paid in native ETH.
 *
 * ── What v2 adds over v1 ─────────────────────────────────────────────────────
 *
 *  1. Fees, charged on PROFIT and never on the gross payout. A winner therefore
 *     can never receive less than their principal. Charging the gross would mean a
 *     10 USDC stake winning 11 in a crowded pool could return under 10 — correct
 *     and out of pocket.
 *  2. A fee SNAPSHOT per claim. The policy in force at creation is copied onto the
 *     claim, so a later policy change cannot reach a market whose participants
 *     have already committed money.
 *  3. A timelock on policy changes, with a hard cap the owner cannot exceed. An
 *     immediate unbounded setter would let an admin (or a compromised key) take
 *     most of everyone's profit in one transaction.
 *  4. PULL-based fee claiming. Fees accrue to a balance the recipient withdraws;
 *     pushing to a recipient that reverts would take the whole settlement with it.
 *  5. Agent attribution, so an owner fee is paid to the wallet the market was
 *     created on behalf of.
 *
 * Resolution stays oracle-only, and the mirror of this arithmetic lives in
 * lib/fees.ts — the two are tested against the same cases.
 */
contract MimirV2 {
    // ── State constants ───────────────────────────────────────────────────────
    uint8 public constant ST_OPEN        = 0;
    uint8 public constant ST_ACTIVE      = 1;
    uint8 public constant ST_RESOLVED    = 2;
    uint8 public constant ST_CANCELLED   = 3;

    uint8 public constant SIDE_NONE          = 0;
    uint8 public constant SIDE_CREATOR       = 1;
    uint8 public constant SIDE_CHALLENGERS   = 2;
    uint8 public constant SIDE_DRAW          = 3;
    uint8 public constant SIDE_UNRESOLVABLE  = 4;

    // ── Limits ────────────────────────────────────────────────────────────────
    uint256 public constant MAX_CHALLENGERS        = 100;
    uint256 public constant MIN_STAKE              = 2 * 10**6; // 2 USDC
    uint256 public constant DEFAULT_PAYOUT_BPS     = 20_000;    // 2x total return
    uint256 public constant CHALLENGE_LOCK_SECONDS = 60;
    uint256 public constant BPS_DIVISOR            = 10_000;

    /**
     * Hard ceiling on platformFeeBps + agentOwnerFeeBps, checked on every policy
     * change. Immutable by construction: there is no function that can raise it,
     * so no admin action and no compromised key can take more than 10% of profit.
     */
    uint256 public constant MAX_TOTAL_FEE_BPS = 1_000;

    /** A queued policy change cannot take effect before this much time passes. */
    uint256 public constant FEE_TIMELOCK_SECONDS = 2 days;

    // ── Fee policy ────────────────────────────────────────────────────────────
    struct FeePolicy {
        uint16  platformFeeBps;
        uint16  agentOwnerFeeBps;
        address platformRecipient;
    }

    FeePolicy public feePolicy;

    struct PendingFeePolicy {
        uint16  platformFeeBps;
        uint16  agentOwnerFeeBps;
        address platformRecipient;
        uint256 executableAt;
        bool    exists;
    }

    PendingFeePolicy public pendingFeePolicy;

    /** Copied onto each claim at creation and never mutated afterwards. */
    struct FeeSnapshot {
        uint16  platformFeeBps;
        uint16  agentOwnerFeeBps;
        address platformRecipient;
        address agentOwnerRecipient;
    }

    // ── Storage ───────────────────────────────────────────────────────────────
    struct Claim {
        address creator;
        string  question;
        string  creatorPosition;
        string  counterPosition;
        string  resolutionUrl;
        uint256 creatorStake;
        uint256 totalChallengerStake;
        uint256 reservedCreatorLiability;
        uint256 deadline;
        uint8   state;
        uint8   winnerSide;
        string  resolutionSummary;
        uint8   confidence;
        string  category;
        uint256 parentId;
        uint256 challengerCount;
        uint256 createdAt;
        string  marketType;
        string  oddsMode;
        uint256 challengerPayoutBps;
        string  handicapLine;
        string  settlementRule;
        uint256 maxChallengers;
        bool    isPrivate;
        bytes32 inviteKeyHash;
        bytes32 evidenceHash;
        /** Hash/URI of the off-chain MarketContextPack. */
        bytes32 contextHash;
        FeeSnapshot fees;
    }

    mapping(uint256 => Claim)   public claims;
    mapping(uint256 => address) public challengerAddresses;
    mapping(uint256 => uint256) public challengerStakes;
    mapping(uint256 => mapping(address => bool)) public hasChallenged;

    mapping(address => uint256) public wins;
    mapping(address => uint256) public losses;

    /** Pull-payment fallback for failed payout pushes. */
    mapping(address => uint256) public pendingWithdrawals;
    /** Accrued, unclaimed fees. Always pulled, never pushed. */
    mapping(address => uint256) public accruedFees;

    uint256 public claimCount;
    uint256 public totalResolved;
    /** Every fee ever accrued, for reconciliation against the off-chain ledger. */
    uint256 public lifetimeFeesAccrued;
    uint256 public lifetimeFeesClaimed;

    address public owner;
    address public oracle;
    IERC20  public immutable usdc;

    // ── Events ────────────────────────────────────────────────────────────────
    event ClaimCreated(uint256 indexed id, address indexed creator, string category);
    event ClaimChallenged(uint256 indexed id, address indexed challenger, uint256 stake);
    event ClaimResolved(uint256 indexed id, uint8 winnerSide, string summary, uint8 confidence, bytes32 evidenceHash);
    event ClaimCancelled(uint256 indexed id);
    event OracleChanged(address indexed previous, address indexed next);
    event OwnershipTransferred(address indexed previous, address indexed next);
    event WithdrawalPending(address indexed to, uint256 amount);
    event Withdrawal(address indexed to, uint256 amount);

    event FeePolicyQueued(uint16 platformFeeBps, uint16 agentOwnerFeeBps, address indexed platformRecipient, uint256 executableAt);
    event FeePolicyUpdated(uint16 platformFeeBps, uint16 agentOwnerFeeBps, address indexed platformRecipient);
    event FeePolicyCancelled();
    event AgentAttributed(uint256 indexed id, address indexed agentOwnerRecipient);
    event FeeAccrued(uint256 indexed id, address indexed recipient, uint256 amount, bool isAgentOwnerFee);
    event FeeClaimed(address indexed recipient, uint256 amount);
    event MarketSettled(uint256 indexed id, uint256 totalPaid, uint256 totalFees, uint256 dust);

    // ── Reentrancy guard ──────────────────────────────────────────────────────
    uint256 private _entered = 1;

    modifier nonReentrant() {
        require(_entered == 1, "Mimir: reentrant call");
        _entered = 2;
        _;
        _entered = 1;
    }

    modifier onlyOwner() {
        require(msg.sender == owner, "Mimir: not owner");
        _;
    }

    modifier onlyOracle() {
        require(msg.sender == oracle, "Mimir: not oracle");
        _;
    }

    // ── Constructor ───────────────────────────────────────────────────────────
    constructor(
        address _oracle,
        address _usdc,
        uint16  _platformFeeBps,
        uint16  _agentOwnerFeeBps,
        address _platformRecipient
    ) {
        require(_oracle != address(0), "Mimir: zero oracle");
        require(_usdc != address(0), "Mimir: zero USDC");
        require(
            uint256(_platformFeeBps) + uint256(_agentOwnerFeeBps) <= MAX_TOTAL_FEE_BPS,
            "Mimir: fee cap"
        );
        if (_platformFeeBps > 0) require(_platformRecipient != address(0), "Mimir: fee needs recipient");

        owner  = msg.sender;
        oracle = _oracle;
        usdc   = IERC20(_usdc);
        feePolicy = FeePolicy(_platformFeeBps, _agentOwnerFeeBps, _platformRecipient);

        emit OracleChanged(address(0), _oracle);
        emit OwnershipTransferred(address(0), msg.sender);
        emit FeePolicyUpdated(_platformFeeBps, _agentOwnerFeeBps, _platformRecipient);
    }

    // ── Admin ─────────────────────────────────────────────────────────────────
    function setOracle(address _oracle) external onlyOwner {
        require(_oracle != address(0), "Mimir: zero oracle");
        emit OracleChanged(oracle, _oracle);
        oracle = _oracle;
    }

    function transferOwnership(address _owner) external onlyOwner {
        require(_owner != address(0), "Mimir: zero owner");
        emit OwnershipTransferred(owner, _owner);
        owner = _owner;
    }

    /**
     * Queue a fee policy change. It cannot be executed until the timelock elapses,
     * so participants have notice — and it can never exceed the constant cap, so
     * even a compromised owner key cannot seize most of everyone's profit.
     */
    function queueFeePolicy(
        uint16  _platformFeeBps,
        uint16  _agentOwnerFeeBps,
        address _platformRecipient
    ) external onlyOwner {
        require(
            uint256(_platformFeeBps) + uint256(_agentOwnerFeeBps) <= MAX_TOTAL_FEE_BPS,
            "Mimir: fee cap"
        );
        if (_platformFeeBps > 0) require(_platformRecipient != address(0), "Mimir: fee needs recipient");

        uint256 executableAt = block.timestamp + FEE_TIMELOCK_SECONDS;
        pendingFeePolicy = PendingFeePolicy(
            _platformFeeBps,
            _agentOwnerFeeBps,
            _platformRecipient,
            executableAt,
            true
        );
        emit FeePolicyQueued(_platformFeeBps, _agentOwnerFeeBps, _platformRecipient, executableAt);
    }

    function cancelFeePolicy() external onlyOwner {
        require(pendingFeePolicy.exists, "Mimir: nothing queued");
        delete pendingFeePolicy;
        emit FeePolicyCancelled();
    }

    /**
     * Execute a queued policy. Permissionless once the timelock has elapsed: the
     * change was already public, and requiring the owner again would let a lost
     * key strand the queue forever.
     */
    function executeFeePolicy() external {
        PendingFeePolicy memory queued = pendingFeePolicy;
        require(queued.exists, "Mimir: nothing queued");
        require(block.timestamp >= queued.executableAt, "Mimir: timelock");

        feePolicy = FeePolicy(queued.platformFeeBps, queued.agentOwnerFeeBps, queued.platformRecipient);
        delete pendingFeePolicy;
        emit FeePolicyUpdated(queued.platformFeeBps, queued.agentOwnerFeeBps, queued.platformRecipient);
    }

    // ── Internal helpers ──────────────────────────────────────────────────────
    function _chKey(uint256 claimId, uint256 index) internal pure returns (uint256) {
        return claimId * MAX_CHALLENGERS + index;
    }

    function _pullStake(uint256 amount) internal {
        require(amount > 0, "Mimir: zero stake");
        uint256 beforeBalance = usdc.balanceOf(address(this));
        bool ok = usdc.transferFrom(msg.sender, address(this), amount);
        require(ok, "Mimir: USDC pull failed");
        // MimirV2 accounts in exact atomic USDC units. Fee-on-transfer and
        // rebasing assets would break escrow conservation, so reject them even
        // if a misconfigured deployment points `usdc` at such a token.
        require(usdc.balanceOf(address(this)) == beforeBalance + amount, "Mimir: unsupported token");
    }

    /**
     * Push a payout; park it on any failure.
     *
     * USDC does not merely return false — a blacklisted recipient makes transfer
     * REVERT, which would otherwise strand every other payout in the same
     * resolveClaim. Hence the low-level call rather than SafeERC20.
     */
    function _transfer(address to, uint256 amount) internal {
        if (amount == 0) return;
        (bool called, bytes memory ret) = address(usdc).call(
            abi.encodeWithSelector(IERC20.transfer.selector, to, amount)
        );
        bool ok = called && (ret.length == 0 || abi.decode(ret, (bool)));
        if (!ok) {
            pendingWithdrawals[to] += amount;
            emit WithdrawalPending(to, amount);
        }
    }

    function _grossPayout(uint256 stake, uint256 bps) internal pure returns (uint256) {
        return (stake * bps) / BPS_DIVISOR;
    }

    /**
     * Split a gross payout into fees and the amount owed.
     *
     * Fees apply to PROFIT only, so `owed` can never fall below `principal` for a
     * winner. Integer division truncates, which rounds fees down in the
     * participant's favour; the remainder stays in escrow as dust.
     */
    function _applyFees(
        uint256 claimId,
        uint256 principal,
        uint256 grossPayout,
        FeeSnapshot memory fees
    ) internal returns (uint256 owed, uint256 feesTaken) {
        if (grossPayout <= principal) return (grossPayout, 0);

        uint256 profit = grossPayout - principal;
        uint256 platformFee = (profit * fees.platformFeeBps) / BPS_DIVISOR;
        uint256 ownerFee = fees.agentOwnerRecipient == address(0)
            ? 0
            : (profit * fees.agentOwnerFeeBps) / BPS_DIVISOR;

        if (platformFee > 0) {
            accruedFees[fees.platformRecipient] += platformFee;
            lifetimeFeesAccrued += platformFee;
            emit FeeAccrued(claimId, fees.platformRecipient, platformFee, false);
        }
        if (ownerFee > 0) {
            accruedFees[fees.agentOwnerRecipient] += ownerFee;
            lifetimeFeesAccrued += ownerFee;
            emit FeeAccrued(claimId, fees.agentOwnerRecipient, ownerFee, true);
        }

        feesTaken = platformFee + ownerFee;
        owed = grossPayout - feesTaken;
    }

    // ── Withdrawals ───────────────────────────────────────────────────────────
    function withdraw() external nonReentrant {
        uint256 amount = pendingWithdrawals[msg.sender];
        require(amount > 0, "Mimir: nothing to withdraw");
        pendingWithdrawals[msg.sender] = 0;
        bool ok = usdc.transfer(msg.sender, amount);
        require(ok, "Mimir: withdraw failed");
        emit Withdrawal(msg.sender, amount);
    }

    /**
     * Claim accrued fees. Pull, not push: a fee recipient that reverts on receipt
     * must not be able to block a settlement.
     */
    function claimFees() external nonReentrant {
        uint256 amount = accruedFees[msg.sender];
        require(amount > 0, "Mimir: no fees");
        accruedFees[msg.sender] = 0; // effects before interaction
        lifetimeFeesClaimed += amount;
        bool ok = usdc.transfer(msg.sender, amount);
        require(ok, "Mimir: fee transfer failed");
        emit FeeClaimed(msg.sender, amount);
    }

    // ── Write: create ─────────────────────────────────────────────────────────
    struct CreateParams {
        string  question;
        string  creatorPosition;
        string  counterPosition;
        string  resolutionUrl;
        uint256 deadline;
        uint256 stakeAmount;
        string  category;
        uint256 parentId;
        string  marketType;
        string  oddsMode;
        uint256 challengerPayoutBps;
        string  handicapLine;
        string  settlementRule;
        uint256 maxChallengers;
        bool    isPrivate;
        string  inviteKey;
        bytes32 contextHash;
        /** Zero when the market is not attributed to an agent. */
        address agentOwnerRecipient;
    }

    function createClaim(CreateParams calldata params)
        external
        nonReentrant
        returns (uint256 id)
    {
        require(params.stakeAmount >= MIN_STAKE, "Mimir: stake too small");
        require(params.deadline > block.timestamp, "Mimir: deadline in past");
        require(bytes(params.question).length > 0, "Mimir: empty question");

        _pullStake(params.stakeAmount);

        bool isFixed = _strEq(params.oddsMode, "fixed");
        uint256 payoutBps = isFixed
            ? (params.challengerPayoutBps >= BPS_DIVISOR ? params.challengerPayoutBps : DEFAULT_PAYOUT_BPS)
            : 0;

        uint256 maxCh = (params.maxChallengers == 0 || params.maxChallengers > MAX_CHALLENGERS)
            ? MAX_CHALLENGERS
            : params.maxChallengers;

        claimCount++;
        id = claimCount;

        // The policy in force NOW is frozen onto the claim. A later change cannot
        // reach a market whose participants have already committed money.
        FeePolicy memory current = feePolicy;
        FeeSnapshot memory snapshot = FeeSnapshot({
            platformFeeBps:      current.platformFeeBps,
            agentOwnerFeeBps:    current.agentOwnerFeeBps,
            platformRecipient:   current.platformRecipient,
            agentOwnerRecipient: params.agentOwnerRecipient
        });

        claims[id] = Claim({
            creator:                  msg.sender,
            question:                 params.question,
            creatorPosition:          params.creatorPosition,
            counterPosition:          params.counterPosition,
            resolutionUrl:            params.resolutionUrl,
            creatorStake:             params.stakeAmount,
            totalChallengerStake:     0,
            reservedCreatorLiability: 0,
            deadline:                 params.deadline,
            state:                    ST_OPEN,
            winnerSide:               SIDE_NONE,
            resolutionSummary:        "",
            confidence:               0,
            category:                 bytes(params.category).length > 0 ? params.category : "custom",
            parentId:                 params.parentId,
            challengerCount:          0,
            createdAt:                block.timestamp,
            marketType:               bytes(params.marketType).length > 0 ? params.marketType : "binary",
            oddsMode:                 isFixed ? "fixed" : "pool",
            challengerPayoutBps:      payoutBps,
            handicapLine:             params.handicapLine,
            settlementRule:           params.settlementRule,
            maxChallengers:           maxCh,
            isPrivate:                params.isPrivate,
            inviteKeyHash:            bytes(params.inviteKey).length > 0
                                          ? keccak256(bytes(params.inviteKey))
                                          : bytes32(0),
            evidenceHash:             bytes32(0),
            contextHash:              params.contextHash,
            fees:                     snapshot
        });

        emit ClaimCreated(id, msg.sender, params.category);
        if (params.agentOwnerRecipient != address(0)) {
            emit AgentAttributed(id, params.agentOwnerRecipient);
        }
    }

    // ── Write: challenge ──────────────────────────────────────────────────────
    function challengeClaim(
        uint256 claimId,
        uint256 stakeAmount,
        string  calldata inviteKey
    ) external nonReentrant {
        Claim storage claim = claims[claimId];
        require(claim.creator != address(0), "Mimir: claim not found");
        require(claim.state == ST_OPEN || claim.state == ST_ACTIVE, "Mimir: not open");
        require(msg.sender != claim.creator, "Mimir: self-challenge");
        require(!hasChallenged[claimId][msg.sender], "Mimir: already challenged");
        require(claim.challengerCount < claim.maxChallengers, "Mimir: full");
        require(stakeAmount >= MIN_STAKE, "Mimir: stake too small");
        require(
            block.timestamp + CHALLENGE_LOCK_SECONDS <= claim.deadline,
            "Mimir: challenge window closed"
        );

        if (claim.isPrivate && claim.inviteKeyHash != bytes32(0)) {
            require(
                keccak256(bytes(inviteKey)) == claim.inviteKeyHash,
                "Mimir: invalid invite key"
            );
        }

        // A one-slot market is a duel, so the stakes must match. v1 could not
        // enforce this on chain and relied on an off-chain guard; v2 can.
        if (claim.maxChallengers == 1) {
            require(stakeAmount == claim.creatorStake, "Mimir: duel needs an equal stake");
        }

        if (_strEq(claim.oddsMode, "fixed")) {
            uint256 gross   = _grossPayout(stakeAmount, claim.challengerPayoutBps);
            uint256 profit  = gross > stakeAmount ? gross - stakeAmount : 0;
            uint256 avail   = claim.creatorStake - claim.reservedCreatorLiability;
            require(avail >= profit, "Mimir: creator has insufficient liquidity");
            claim.reservedCreatorLiability += profit;
        }

        _pullStake(stakeAmount);

        uint256 key = _chKey(claimId, claim.challengerCount);
        challengerAddresses[key]           = msg.sender;
        challengerStakes[key]              = stakeAmount;
        hasChallenged[claimId][msg.sender] = true;

        claim.totalChallengerStake += stakeAmount;
        claim.challengerCount++;
        claim.state = ST_ACTIVE;

        emit ClaimChallenged(claimId, msg.sender, stakeAmount);
    }

    // ── Write: resolve (oracle only) ──────────────────────────────────────────
    function resolveClaim(
        uint256 claimId,
        uint8   winnerSide,
        string  calldata summary,
        uint8   confidence,
        bytes32 evidenceHash
    ) external onlyOracle nonReentrant {
        Claim storage claim = claims[claimId];
        require(claim.creator != address(0), "Mimir: claim not found");
        require(claim.state == ST_ACTIVE, "Mimir: not active");
        require(block.timestamp >= claim.deadline, "Mimir: not yet expired");
        require(
            winnerSide == SIDE_CREATOR ||
            winnerSide == SIDE_CHALLENGERS ||
            winnerSide == SIDE_DRAW ||
            winnerSide == SIDE_UNRESOLVABLE,
            "Mimir: invalid verdict"
        );

        claim.state             = ST_RESOLVED;
        claim.winnerSide        = winnerSide;
        claim.resolutionSummary = summary;
        claim.confidence        = confidence;
        claim.evidenceHash      = evidenceHash;
        totalResolved++;

        uint256 inflow = claim.creatorStake + claim.totalChallengerStake;
        uint256 paid;
        uint256 fees;

        if (winnerSide == SIDE_CREATOR) {
            (uint256 owed, uint256 taken) = _applyFees(
                claimId,
                claim.creatorStake,
                claim.creatorStake + claim.totalChallengerStake,
                claim.fees
            );
            _transfer(claim.creator, owed);
            paid += owed;
            fees += taken;

            wins[claim.creator]++;
            for (uint256 i = 0; i < claim.challengerCount; i++) {
                losses[challengerAddresses[_chKey(claimId, i)]]++;
            }

        } else if (winnerSide == SIDE_CHALLENGERS) {
            bool isFixed      = _strEq(claim.oddsMode, "fixed");
            uint256 remainder = claim.creatorStake;

            for (uint256 i = 0; i < claim.challengerCount; i++) {
                uint256 key      = _chKey(claimId, i);
                address ch       = challengerAddresses[key];
                uint256 chStake  = challengerStakes[key];
                uint256 gross;

                if (isFixed) {
                    gross = _grossPayout(chStake, claim.challengerPayoutBps);
                    uint256 profit = gross > chStake ? gross - chStake : 0;
                    remainder = remainder > profit ? remainder - profit : 0;
                } else {
                    uint256 share = (chStake * claim.creatorStake) / claim.totalChallengerStake;
                    gross = chStake + share;
                }

                (uint256 owed, uint256 taken) = _applyFees(claimId, chStake, gross, claim.fees);
                _transfer(ch, owed);
                paid += owed;
                fees += taken;
                wins[ch]++;
            }

            losses[claim.creator]++;
            if (isFixed && remainder > 0) {
                // Unspent liability returning to a LOSING creator is a partial
                // refund of principal, not profit, so it carries no fee.
                _transfer(claim.creator, remainder);
                paid += remainder;
            }

        } else {
            // Draw or unresolvable: full refunds, no fee. Taking a cut of a
            // returned stake would make the protocol the only winner of an
            // ambiguous market.
            _transfer(claim.creator, claim.creatorStake);
            paid += claim.creatorStake;
            for (uint256 i = 0; i < claim.challengerCount; i++) {
                uint256 key = _chKey(claimId, i);
                _transfer(challengerAddresses[key], challengerStakes[key]);
                paid += challengerStakes[key];
            }
        }

        // Conservation, asserted on chain: the escrow can never owe more than it
        // took in. Any positive remainder is truncation dust and stays put.
        require(paid + fees <= inflow, "Mimir: payout exceeds escrow");
        emit MarketSettled(claimId, paid, fees, inflow - paid - fees);
        emit ClaimResolved(claimId, winnerSide, summary, confidence, evidenceHash);
    }

    // ── Write: cancel ─────────────────────────────────────────────────────────
    function cancelClaim(uint256 claimId) external nonReentrant {
        Claim storage claim = claims[claimId];
        require(claim.creator != address(0), "Mimir: claim not found");
        require(msg.sender == claim.creator, "Mimir: not creator");
        require(claim.state == ST_OPEN, "Mimir: not open");

        claim.state = ST_CANCELLED;
        // Cancellation is a refund: no fee.
        _transfer(claim.creator, claim.creatorStake);
        emit ClaimCancelled(claimId);
    }

    // ── Views ─────────────────────────────────────────────────────────────────
    function getClaim(uint256 claimId) external view returns (
        address creator,
        string  memory question,
        string  memory creatorPosition,
        string  memory counterPosition,
        string  memory resolutionUrl,
        uint256 creatorStake,
        uint256 totalChallengerStake,
        uint256 reservedCreatorLiability,
        uint256 deadline,
        uint8   state,
        uint8   winnerSide,
        string  memory resolutionSummary,
        uint8   confidence,
        string  memory category,
        uint256 parentId,
        uint256 challengerCount,
        uint256 createdAt,
        bytes32 evidenceHash
    ) {
        Claim storage c = claims[claimId];
        return (
            c.creator, c.question, c.creatorPosition, c.counterPosition,
            c.resolutionUrl, c.creatorStake, c.totalChallengerStake,
            c.reservedCreatorLiability, c.deadline, c.state, c.winnerSide,
            c.resolutionSummary, c.confidence, c.category,
            c.parentId, c.challengerCount, c.createdAt, c.evidenceHash
        );
    }

    function getClaimMarketConfig(uint256 claimId) external view returns (
        string  memory marketType,
        string  memory oddsMode,
        uint256 challengerPayoutBps,
        string  memory handicapLine,
        string  memory settlementRule,
        uint256 maxChallengers,
        bool    isPrivate,
        uint256 reservedCreatorLiability
    ) {
        Claim storage c = claims[claimId];
        return (
            c.marketType, c.oddsMode, c.challengerPayoutBps,
            c.handicapLine, c.settlementRule, c.maxChallengers,
            c.isPrivate, c.reservedCreatorLiability
        );
    }

    /** The fee terms this claim was created under, for display and reconciliation. */
    function getClaimFees(uint256 claimId) external view returns (
        uint16  platformFeeBps,
        uint16  agentOwnerFeeBps,
        address platformRecipient,
        address agentOwnerRecipient,
        bytes32 contextHash
    ) {
        Claim storage c = claims[claimId];
        return (
            c.fees.platformFeeBps,
            c.fees.agentOwnerFeeBps,
            c.fees.platformRecipient,
            c.fees.agentOwnerRecipient,
            c.contextHash
        );
    }

    function getChallenger(uint256 claimId, uint256 index) external view returns (
        address challenger,
        uint256 stake
    ) {
        uint256 key = _chKey(claimId, index);
        return (challengerAddresses[key], challengerStakes[key]);
    }

    function getChallengerList(uint256 claimId) external view returns (
        address[] memory addrs,
        uint256[] memory stakes
    ) {
        uint256 count = claims[claimId].challengerCount;
        addrs  = new address[](count);
        stakes = new uint256[](count);
        for (uint256 i = 0; i < count; i++) {
            uint256 key = _chKey(claimId, i);
            addrs[i]  = challengerAddresses[key];
            stakes[i] = challengerStakes[key];
        }
    }

    function getUserStats(address user) external view returns (uint256 userWins, uint256 userLosses) {
        return (wins[user], losses[user]);
    }

    function getPlatformStats() external view returns (
        uint256 totalClaims,
        uint256 resolved,
        uint256 balance,
        uint256 feesAccrued,
        uint256 feesClaimed
    ) {
        return (claimCount, totalResolved, usdc.balanceOf(address(this)), lifetimeFeesAccrued, lifetimeFeesClaimed);
    }

    // ── Internal ──────────────────────────────────────────────────────────────
    function _strEq(string memory a, string memory b) internal pure returns (bool) {
        return keccak256(bytes(a)) == keccak256(bytes(b));
    }

}
