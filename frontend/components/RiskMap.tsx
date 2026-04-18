"use client";

import { useRef, useMemo } from "react";
import { Canvas, useFrame } from "@react-three/fiber";
import { OrbitControls, Stars, Line } from "@react-three/drei";
import * as THREE from "three";
import { useRiskStore, type NodeSnapshot } from "@/hooks/useRiskSocket";

// ── Risk Color Mapping ─────────────────────────────────────────────
function riskColor(score: number): THREE.Color {
  if (score < 0.3) return new THREE.Color(0x22c55e);  // Green — low
  if (score < 0.6) return new THREE.Color(0xf59e0b);  // Amber — medium
  if (score < 0.9) return new THREE.Color(0xef4444);  // Red — high
  return new THREE.Color(0xff0040);                     // Critical — pulsing red
}

// ── Node Sphere ────────────────────────────────────────────────────
function RiskNode({
  position,
  snapshot,
}: {
  position: [number, number, number];
  snapshot: NodeSnapshot;
}) {
  const meshRef = useRef<THREE.Mesh>(null!);
  const baseScale = snapshot.isDefaulted ? 0.15 : 0.08;

  useFrame((_, delta) => {
    if (!meshRef.current) return;
    // Pulse defaulted nodes
    if (snapshot.isDefaulted) {
      meshRef.current.scale.setScalar(
        baseScale + Math.sin(Date.now() * 0.005) * 0.03
      );
    }
  });

  return (
    <mesh ref={meshRef} position={position} scale={baseScale}>
      <sphereGeometry args={[1, 16, 16]} />
      <meshStandardMaterial
        color={riskColor(snapshot.riskScore)}
        emissive={riskColor(snapshot.riskScore)}
        emissiveIntensity={snapshot.riskScore * 0.8}
        transparent
        opacity={0.85}
      />
    </mesh>
  );
}

// ── Grid Floor ─────────────────────────────────────────────────────
function GridFloor() {
  return (
    <gridHelper
      args={[40, 40, "#1e293b", "#0f172a"]}
      position={[0, -5, 0]}
      rotation={[0, 0, 0]}
    />
  );
}

// ── Node Layout (Spherical Distribution) ───────────────────────────
function computeNodePositions(
  count: number,
  radius: number = 8
): [number, number, number][] {
  const positions: [number, number, number][] = [];
  const goldenRatio = (1 + Math.sqrt(5)) / 2;

  for (let i = 0; i < count; i++) {
    const theta = (2 * Math.PI * i) / goldenRatio;
    const phi = Math.acos(1 - (2 * (i + 0.5)) / count);
    const x = radius * Math.cos(theta) * Math.sin(phi);
    const y = radius * Math.cos(phi);
    const z = radius * Math.sin(theta) * Math.sin(phi);
    positions.push([x, y, z]);
  }

  return positions;
}

// ── Scene Content ──────────────────────────────────────────────────
function RiskScene() {
  const nodes = useRiskStore((s) => s.nodes);
  const groupRef = useRef<THREE.Group>(null!);

  // Slow rotation of the entire graph
  useFrame((_, delta) => {
    if (groupRef.current) {
      groupRef.current.rotation.y += delta * 0.05;
    }
  });

  // Compute positions for all known nodes
  const positions = useMemo(
    () => computeNodePositions(Math.max(nodes.size, 100)),
    [nodes.size]
  );

  const nodeEntries = useMemo(() => Array.from(nodes.entries()), [nodes]);

  return (
    <group ref={groupRef}>
      {/* Render each node as a sphere */}
      {nodeEntries.map(([id, snapshot]) => {
        const posIdx = id % positions.length;
        return (
          <RiskNode
            key={id}
            position={positions[posIdx]}
            snapshot={snapshot}
          />
        );
      })}

      {/* Placeholder spheres when no data is connected */}
      {nodes.size === 0 &&
        positions.slice(0, 100).map((pos, i) => (
          <mesh key={`placeholder-${i}`} position={pos} scale={0.05}>
            <sphereGeometry args={[1, 8, 8]} />
            <meshStandardMaterial
              color="#334155"
              transparent
              opacity={0.3}
            />
          </mesh>
        ))}
    </group>
  );
}

// ── Main Canvas Export ─────────────────────────────────────────────
export default function RiskMap() {
  return (
    <Canvas
      camera={{ position: [0, 5, 18], fov: 55 }}
      gl={{ antialias: true, alpha: false }}
      style={{ background: "#0a0a0f" }}
    >
      {/* Lighting */}
      <ambientLight intensity={0.15} />
      <pointLight position={[10, 15, 10]} intensity={0.6} color="#6366f1" />
      <pointLight position={[-10, -10, -5]} intensity={0.3} color="#3b82f6" />

      {/* Environment */}
      <Stars
        radius={100}
        depth={60}
        count={2000}
        factor={3}
        saturation={0}
        fade
        speed={0.5}
      />
      <fog attach="fog" args={["#0a0a0f", 20, 50]} />
      <GridFloor />

      {/* Risk Graph */}
      <RiskScene />

      {/* Camera Controls */}
      <OrbitControls
        enablePan={true}
        enableZoom={true}
        enableRotate={true}
        autoRotate={false}
        maxDistance={40}
        minDistance={5}
      />
    </Canvas>
  );
}
