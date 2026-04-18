import numpy as np
import scipy.stats as stats
import struct
import json
import os

# =============================================================================
# infer_network.py — Cutting-Edge QR Network Inference Engine
#
# Replaces random toy data with rigorous systemic risk models.
# - Interbank Topology: Core-Periphery (Craig & Von Peter)
# - Link Weights: Sinkhorn-Knopp / Matrix Balancing (Upper, 2004)
# - Portfolios: Copulation-driven Fat Tails
# - Baseline Risk: Merton's Distance to Default (DtD) via Ito Calculus
# =============================================================================

NUM_NODES = 500
MAX_EDGES = 8192
ASSET_CLASSES = 5

def generate_portfolios(num_nodes, total_assets):
    """
    Generate asset limits using a Gaussian Copula mapping to fat-tailed 
    Student-T margins, respecting inter-asset correlation.
    Assets: Equities(0), Real Estate(1), Crypto(2), Treasuries(3), Corp Bonds(4)
    """
    # Covariance Matrix: Real Estate & Crypto correlate with Equities. Treasuries are inverse.
    cov = np.array([
        [ 1.0,  0.5,  0.6, -0.4,  0.3], # Equities
        [ 0.5,  1.0,  0.3, -0.2,  0.4], # Real Estate
        [ 0.6,  0.3,  1.0, -0.1,  0.1], # Crypto
        [-0.4, -0.2, -0.1,  1.0,  0.6], # Treasuries (Flight to safety)
        [ 0.3,  0.4,  0.1,  0.6,  1.0]  # Corp Bonds
    ])
    
    # 1. Sample Z ~ N(0, Cov)
    Z = np.random.multivariate_normal(mean=np.zeros(5), cov=cov, size=num_nodes)
    
    # 2. Map Z to Uniform Marginals U ~ U(0,1)
    U = stats.norm.cdf(Z)
    
    # 3. Map U to fat-tailed margins (e.g., Log-Normal or Student-t)
    # We use inverse Pareto/T to get extreme tail values in exposure
    weights = np.zeros((num_nodes, 5))
    weights[:, 0] = stats.t.ppf(U[:, 0], df=4) + 5  # Equities (shifted to be positive)
    weights[:, 1] = stats.t.ppf(U[:, 1], df=5) + 3  # RE
    weights[:, 2] = stats.t.ppf(U[:, 2], df=2.5) + 2 # Crypto (fattest tails, df=2.5)
    weights[:, 3] = stats.norm.ppf(U[:, 3]) + 4     # Treasuries (normal)
    weights[:, 4] = stats.norm.ppf(U[:, 4]) + 4     # Corp Bonds
    
    # Floor at a tiny positive value to prevent shorts
    weights = np.maximum(weights, 0.01)
    
    # Normalize heavily to sum to 1.0 per firm
    row_sums = weights.sum(axis=1, keepdims=True)
    normalized_weights = weights / row_sums
    
    portfolios = normalized_weights * total_assets[:, None]
    return portfolios

def sinkhorn_knopp_interbank(core_indices, periph_indices, liabilities, loan_assets, max_iter=200):
    """
    Maximum Entropy estimation of bilateral exposures.
    We know exactly how much debt a firm owes (liabilities) and how much
    interbank credit they extend (loan_assets). We want to infer the matrix M 
    where M[i,j] is what i owes to j.
    """
    N = NUM_NODES
    M_init = np.zeros((N, N))
    
    # Core-Periphery Structure:
    # - Core lends to Core, Core lends to Periphery
    # - Periphery lends to Core
    # - Periphery RARELY lends to Periphery
    
    # Pre-fill structural zeros and ones
    for i in range(N):
        for j in range(N):
            if i == j: continue
            
            i_is_core = i in core_indices
            j_is_core = j in core_indices
            
            if i_is_core and j_is_core:
                M_init[i, j] = 1.0
            elif i_is_core and not j_is_core:
                M_init[i, j] = 0.5  # Partial connectivity
            elif not i_is_core and j_is_core:
                M_init[i, j] = 0.5
            else:
                M_init[i, j] = 0.05 # Periphery-to-periphery is rare
                
            # Distance-gravity model: bigger firms trade more
            M_init[i,j] *= (max(loan_assets[j], 1e-3) * max(liabilities[i], 1e-3))
    
    # Add noise
    M_init *= np.random.uniform(0.8, 1.2, size=(N, N))
    np.fill_diagonal(M_init, 0.0)

    # Sinkhorn Balancing (RAS method)
    M = M_init.copy()
    for _ in range(max_iter):
        # Scale rows to match liabilities
        row_sums = M.sum(axis=1)
        row_sums[row_sums == 0] = 1.0
        M = M * (liabilities[:, None] / row_sums[:, None])
        
        # Scale cols to match loan assets
        col_sums = M.sum(axis=0)
        col_sums[col_sums == 0] = 1.0
        M = M * (loan_assets[None, :] / col_sums[None, :])
        
    return M

def merton_distance_to_default(assets, liabilities, t=1.0, r=0.04):
    """
    Black-Scholes-Merton Structural Model for Probability of Default.
    """
    # Assuming equity volatility is stochastic based on asset size (bigger = less volatile)
    # Range from 0.15 (15%) for mega-banks to 0.80 (80%) for tiny crypto funds
    rank = stats.rankdata(assets) / len(assets)
    volatility = 0.80 - (0.65 * rank) 
    
    # d2 formula
    # If liabilities are 0, PD is 0
    pd = np.zeros_like(assets)
    for i in range(len(assets)):
        V = max(assets[i], 1e-3)
        D = liabilities[i]
        sigma = volatility[i]
        
        if D <= 1e-3:
            pd[i] = 0.001
        else:
            d2 = (np.log(V / D) + (r - 0.5 * sigma**2) * t) / (sigma * np.sqrt(t))
            prob = stats.norm.cdf(-d2) # Probability of Default is N(-d2)
            pd[i] = min(max(prob, 0.001), 0.99)
            
    return pd

def run_inference():
    np.random.seed(42) # Deterministic graph for identical replays
    
    print("1/5 Drawing Asset Distributions...")
    # Power Law firm sizes. Multiplying by 100M to align with C++ expectations
    total_assets = (np.random.pareto(1.16, NUM_NODES) + 1.0) * 100_000_000
    
    print("2/5 Simulating Copula Portfolios...")
    exposures = generate_portfolios(NUM_NODES, total_assets)
    
    print("3/5 Establishing Interbank Core-Periphery Topology...")
    # Top 5% of firms by assets form the Core (Hubs)
    core_cutoff = np.percentile(total_assets, 95)
    core_idx = np.where(total_assets >= core_cutoff)[0]
    periph_idx = np.where(total_assets < core_cutoff)[0]
    
    # Synthetic Interbank Loans / Liabilities margins
    # Mega-banks lend heavily. Tiny banks borrow heavily.
    leverage = np.random.uniform(1.2, 5.0, size=NUM_NODES)
    # Some assets are tied up in interbank lending, rest in market exposures.
    # To keep total_assets roughly matching the sum, we pretend `total_assets` = Market + Interbank
    # But for simplicity, we'll just assign standalone Interbank vectors.
    liabilities = total_assets * np.random.uniform(0.1, 0.8, size=NUM_NODES)
    loan_assets = total_assets * np.random.uniform(0.1, 0.8, size=NUM_NODES)
    
    print("4/5 Solving Maximum Entropy Debt Matrix via Sinkhorn-Knopp...")
    debt_matrix = sinkhorn_knopp_interbank(core_idx, periph_idx, liabilities, loan_assets)
    
    # Threshold the dense matrix back into a sparse CSR graph
    # Keep only top edges per node to maintain MAX_EDGES budget
    max_edges_per_node = 15
    row_ptr = np.zeros(NUM_NODES + 1, dtype=np.uint32)
    col_idx = []
    weights = []
    
    edge_count = 0
    actual_liabilities = np.zeros(NUM_NODES)
    
    for i in range(NUM_NODES):
        row = debt_matrix[i, :]
        # Get indices of top connections
        top_k = np.argsort(row)[-max_edges_per_node:]
        
        for j in top_k:
            w = row[j]
            if w > 1e4: # Minimum $10k debt
                if edge_count >= MAX_EDGES:
                    break
                col_idx.append(j)
                weights.append(w)
                actual_liabilities[i] += w
                edge_count += 1
                
        row_ptr[i+1] = edge_count

    print(f"    Selected {edge_count} critical contagion vectors.")

    print("5/5 Inferring Merton Distance-to-Default Risk Margins...")
    # Finalize NAV = Assets - Liabilities
    nav = total_assets - actual_liabilities
    risk_scores = merton_distance_to_default(total_assets, actual_liabilities)
    
    return total_assets, exposures, actual_liabilities, nav, risk_scores, row_ptr, col_idx, weights

# =============================================================================
# EXPORTER
# =============================================================================

def export_binary(total_assets, exposures, liabilities, nav, risk_scores, row_ptr, col_idx, weights):
    """
    Serializes exactly matching the std::array layout in C++
    NodeData: 500 floats, 500 uint8s, etc.
    CSREdges: 501 uint32s, 8192 uint32s, 8192 doubles.
    """
    filepath = os.path.join(os.path.dirname(__file__), '..', 'optirisk_memory.bin')
    print(f"\nSerializing C++ zero-copy memory dump to {filepath}")
    
    with open(filepath, 'wb') as f:
        # ---- NodeData ----
        
        # risk_score (float x 500)
        f.write(np.array(risk_scores, dtype=np.float32).tobytes())
        # is_defaulted (uint8 x 500)
        f.write(np.zeros(NUM_NODES, dtype=np.uint8).tobytes())
        
        # is_hero_firm (uint8 x 500) -> Pick biggest firm
        hero = np.zeros(NUM_NODES, dtype=np.uint8)
        hero_idx = np.argmax(total_assets)
        hero[hero_idx] = 1
        f.write(hero.tobytes())
        
        # equities, re, crypto, treasuries, corp_bonds (double x 500 each)
        f.write(np.array(exposures[:, 0], dtype=np.float64).tobytes())
        f.write(np.array(exposures[:, 1], dtype=np.float64).tobytes())
        f.write(np.array(exposures[:, 2], dtype=np.float64).tobytes())
        f.write(np.array(exposures[:, 3], dtype=np.float64).tobytes())
        f.write(np.array(exposures[:, 4], dtype=np.float64).tobytes())
        
        # total_assets, liabilities, nav (double x 500 each)
        f.write(np.array(total_assets, dtype=np.float64).tobytes())
        f.write(np.array(liabilities, dtype=np.float64).tobytes())
        f.write(np.array(nav, dtype=np.float64).tobytes())
        
        # credit_rating (float x 500) - Map PD to credit rating synthetically
        cr = 1.0 - np.array(risk_scores, dtype=np.float32)
        f.write(cr.tobytes())
        
        # sector_id (uint32 x 500)
        sectors = np.random.randint(0, 10, size=NUM_NODES, dtype=np.uint32)
        f.write(sectors.tobytes())
        
        # Geo (lat/lon float x 500) + hub_id (uint8 x 500)
        lats = np.random.uniform(-90, 90, size=NUM_NODES).astype(np.float32)
        lons = np.random.uniform(-180, 180, size=NUM_NODES).astype(np.float32)
        hubs_arr = np.random.randint(0, 5, size=NUM_NODES, dtype=np.uint8)
        f.write(lats.tobytes())
        f.write(lons.tobytes())
        f.write(hubs_arr.tobytes())

        # ---- CSREdges ----
        # row_ptr (uint32 x 501)
        f.write(np.array(row_ptr, dtype=np.uint32).tobytes())
        
        # col_idx (uint32 x 8192) padding to MAX_EDGES
        padded_col = np.zeros(MAX_EDGES, dtype=np.uint32)
        padded_col[:len(col_idx)] = col_idx
        f.write(padded_col.tobytes())
        
        # weight (double x 8192) padding to MAX_EDGES
        padded_weights = np.zeros(MAX_EDGES, dtype=np.float64)
        padded_weights[:len(weights)] = weights
        f.write(padded_weights.tobytes())
        
        # num_nodes (uint32)
        f.write(np.array([NUM_NODES], dtype=np.uint32).tobytes())
        # num_edges (uint32)
        f.write(np.array([len(weights)], dtype=np.uint32).tobytes())
        # hero_id (uint32) - pass to main.cpp
        f.write(np.array([hero_idx], dtype=np.uint32).tobytes())

    # ---- JSON WebGL Export (Preserving backwards compatibility for UI) ----
    json_path = os.path.join(os.path.dirname(__file__), '..', 'optirisk_initial_state.json')
    # Generate realistic financial firm names
    prefixes = ["Apex", "Silver", "Jane", "Citadel", "Optima", "Quantum", "Bridgewater", "AQR", "Two", "Cascade", "Virtu", "Sequoia", "Milestone", "Stone", "Vanguard", "Horizon", "Blue", "Black", "Red", "White"]
    middles = ["Point", "Street", "River", "Rock", "Ocean", "Sigma", "Tree", "Peak", "Valley", "Stone", "Oak", "Pine", "Coast", "Sky", "Star"]
    suffixes = ["Capital", "Management", "Trading", "Partners", "Fund", "Group", "Holdings", "Asset Management", "LLC", "L.P.", "Global"]
    
    nodes_json = []
    hubs = ["NYC", "London", "Tokyo", "HongKong", "Dubai"]
    
    np.random.seed(42) # Deterministic names
    for i in range(NUM_NODES):
        # Construct Name
        if i == hero_idx:
            firm_name = "Optima Cascade (HERO)"
        else:
            p = np.random.choice(prefixes)
            m = np.random.choice(middles) if np.random.random() > 0.4 else ""
            s = np.random.choice(suffixes)
            firm_name = f"{p} {m} {s}".replace("  ", " ").strip()

        nodes_json.append({
            "id": i,
            "name": firm_name,
            "is_hero_firm": bool(i == hero_idx),
            "hub": hubs[int(hubs_arr[i])],
            "location": {"lat": round(float(lats[i]), 4), "lon": round(float(lons[i]), 4)},
            "portfolio": {
                "Equities": round(float(exposures[i, 0]), 2),
                "Real_Estate": round(float(exposures[i, 1]), 2),
                "Crypto": round(float(exposures[i, 2]), 2),
                "Treasuries": round(float(exposures[i, 3]), 2),
                "Corp_Bonds": round(float(exposures[i, 4]), 2),
            },
            "total_assets": round(float(total_assets[i]), 2),
            "liabilities": round(float(liabilities[i]), 2),
            "nav": round(float(nav[i]), 2)
        })
        
    edges_json = []
    for i in range(NUM_NODES):
        start = row_ptr[i]
        end = row_ptr[i+1] # We can use python slice here
        for e in range(start, end):
            edges_json.append({
                "debtor_id": int(i),
                "creditor_id": int(col_idx[e]),
                "amount": round(float(weights[e]), 2)
            })
            
    output = {
        "market_anchors": {"Equities": 500.0, "Real_Estate": 80.0, "Crypto": 60000.0, "Treasuries": 90.0, "Corp_Bonds": 105.0},
        "nodes": nodes_json,
        "edges": edges_json
    }
    with open(json_path, 'w') as f:
        json.dump(output, f, indent=2)

    print(f"Memory map saved. Exact 1-to-1 byte layout for raw C++ fread.")

if __name__ == "__main__":
    t, e, l, n, r, rp, ci, w = run_inference()
    export_binary(t, e, l, n, r, rp, ci, w)
