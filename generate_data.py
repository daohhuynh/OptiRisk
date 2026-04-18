import yfinance as yf
import json
import numpy as np

print("Initializing Advanced Probabilistic Inference Engine...")

# 1. Fetch Real-World Market Anchors
tickers = {"Equities": "SPY", "Real_Estate": "VNQ", "Crypto": "BTC-USD", "Treasuries": "TLT", "Corp_Bonds": "LQD"}
market_base = {}
for asset, ticker in tickers.items():
    try:
        data = yf.Ticker(ticker).history(period="1d")
        market_base[asset] = round(data['Close'].iloc[-1], 2) if not data.empty else 100.0
    except:
        market_base[asset] = 100.0

# 2. Geospatial Gaussian Centers (Using mean lat/lon and covariance for clustering)
# NYC, London, Tokyo, Hong Kong, Dubai
hubs = [
    {"name": "NYC", "mean": [40.7128, -74.0060], "cov": [[1.0, 0], [0, 1.0]]},
    {"name": "London", "mean": [51.5074, -0.1278], "cov": [[0.5, 0], [0, 0.5]]},
    {"name": "Tokyo", "mean": [35.6762, 139.6503], "cov": [[0.8, 0], [0, 0.8]]},
    {"name": "Hong Kong", "mean": [22.3193, 114.1694], "cov": [[0.2, 0], [0, 0.2]]},
    {"name": "Dubai", "mean": [25.2048, 55.2708], "cov": [[0.4, 0], [0, 0.4]]}
]

NUM_NODES = 500
nodes = []

print("Generating Pareto-Distributed Entities...")
# Generate Power-Law asset sizes (Alpha=1.16). Multiply by 100M baseline.
pareto_sizes = (np.random.pareto(1.16, NUM_NODES) + 1) * 100_000_000 

for i in range(NUM_NODES):
    hub = hubs[np.random.choice(len(hubs))]
    
    # Bivariate Gaussian for realistic geographic clustering (suburbs around hubs)
    lat, lon = np.random.multivariate_normal(hub["mean"], hub["cov"])
    
    total_assets = round(pareto_sizes[i], 2)
    
    # Dirichlet Distribution for portfolio allocation (sums to 1.0)
    # Alphas represent the "average" market weight: Heavy on Equities/Treasuries, light on Crypto
    alphas = [4.0, 2.0, 0.5, 3.0, 2.5] 
    weights = np.random.dirichlet(alphas)
    
    portfolio = {
        "Equities": round(weights[0] * total_assets, 2),
        "Real_Estate": round(weights[1] * total_assets, 2),
        "Crypto": round(weights[2] * total_assets, 2),
        "Treasuries": round(weights[3] * total_assets, 2),
        "Corp_Bonds": round(weights[4] * total_assets, 2),
    }
    
    nodes.append({
        "id": i,
        "is_hero_firm": i == np.argmax(pareto_sizes), # The absolute biggest firm is the User
        "hub": hub["name"],
        "location": {"lat": round(lat, 4), "lon": round(lon, 4)},
        "portfolio": portfolio,
        "total_assets": total_assets,
        "liabilities": 0.0,
        "nav": 0.0
    })

print("Calculating Scale-Free Debt Web via Preferential Attachment...")
edges = []
# Create probability weights based on asset size
asset_array = np.array([n["total_assets"] for n in nodes])
attachment_probs = asset_array / asset_array.sum()

for i in range(NUM_NODES):
    # Firms have between 2 and 12 counterparty debts
    num_creditors = np.random.randint(2, 13)
    
    # Pick creditors using the Preferential Attachment probabilities!
    creditors = np.random.choice(NUM_NODES, size=num_creditors, replace=False, p=attachment_probs)
    
    for creditor in creditors:
        if creditor == i: continue
        
        # Debt size is a realistic 2% to 15% of their total assets
        debt_amount = round(nodes[i]["total_assets"] * np.random.uniform(0.02, 0.15), 2)
        edges.append({
            "debtor_id": int(i),
            "creditor_id": int(creditor),
            "amount": debt_amount
        })
        nodes[i]["liabilities"] += debt_amount

# Finalize Net Asset Value
for node in nodes:
    node["nav"] = round(node["total_assets"] - node["liabilities"], 2)

output = {
    "market_anchors": market_base,
    "nodes": nodes,
    "edges": edges
}

with open("optirisk_initial_state.json", "w") as f:
    json.dump(output, f, indent=2)

print("✅ Quant-Grade optirisk_initial_state.json generated.")