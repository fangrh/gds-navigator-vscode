#![forbid(unsafe_op_in_unsafe_fn)]

use std::cmp::Ordering;
use std::ptr;

const EPS: f64 = 1e-9;
const MAX_ALLOC: usize = 4_000_000;
const COORD_LIMIT: f64 = 1e100;

#[derive(Clone, Copy, Debug)]
struct Point {
    x: f64,
    y: f64,
}

#[derive(Clone, Copy, Debug)]
struct BBox {
    min_x: f64,
    min_y: f64,
    max_x: f64,
    max_y: f64,
}

impl BBox {
    fn from_points(points: &[Point]) -> Self {
        let mut b = Self {
            min_x: f64::INFINITY,
            min_y: f64::INFINITY,
            max_x: f64::NEG_INFINITY,
            max_y: f64::NEG_INFINITY,
        };
        for p in points {
            b.min_x = b.min_x.min(p.x);
            b.min_y = b.min_y.min(p.y);
            b.max_x = b.max_x.max(p.x);
            b.max_y = b.max_y.max(p.y);
        }
        b
    }

    fn overlaps(self, other: Self) -> bool {
        self.max_x >= other.min_x
            && other.max_x >= self.min_x
            && self.max_y >= other.min_y
            && other.max_y >= self.min_y
    }

    fn expanded(self, amount: f64) -> Self {
        Self {
            min_x: self.min_x - amount,
            min_y: self.min_y - amount,
            max_x: self.max_x + amount,
            max_y: self.max_y + amount,
        }
    }

    fn union(self, other: Self) -> Self {
        Self {
            min_x: self.min_x.min(other.min_x),
            min_y: self.min_y.min(other.min_y),
            max_x: self.max_x.max(other.max_x),
            max_y: self.max_y.max(other.max_y),
        }
    }

    fn extent_x(self) -> f64 {
        self.max_x - self.min_x
    }

    fn extent_y(self) -> f64 {
        self.max_y - self.min_y
    }

    fn center_x(self) -> f64 {
        (self.min_x + self.max_x) * 0.5
    }

    fn center_y(self) -> f64 {
        (self.min_y + self.max_y) * 0.5
    }
}

#[derive(Debug)]
struct Obstacle {
    rings: Vec<Vec<Point>>,
    bbox: BBox,
}

#[derive(Debug)]
struct BvhNode {
    bbox: BBox,
    left: Option<usize>,
    right: Option<usize>,
    obstacles: Vec<usize>,
}

#[derive(Debug)]
pub struct Context {
    obstacles: Vec<Obstacle>,
    nodes: Vec<BvhNode>,
    root: Option<usize>,
}

fn finite_coord(v: f64) -> bool {
    v.is_finite() && v.abs() <= COORD_LIMIT
}

fn valid_query(v: f64) -> bool {
    finite_coord(v)
}

fn parse_integer(v: f64, max: usize) -> Option<usize> {
    if !v.is_finite() || v < 0.0 || v > max as f64 || v.trunc() != v {
        None
    } else {
        Some(v as usize)
    }
}

fn orient(a: Point, b: Point, c: Point) -> f64 {
    (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x)
}

fn dist2(a: Point, b: Point) -> f64 {
    let x = a.x - b.x;
    let y = a.y - b.y;
    x * x + y * y
}

fn dist(a: Point, b: Point) -> f64 {
    dist2(a, b).sqrt()
}

fn on_segment(a: Point, b: Point, p: Point) -> bool {
    orient(a, b, p).abs() <= EPS
        && p.x >= a.x.min(b.x) - EPS
        && p.x <= a.x.max(b.x) + EPS
        && p.y >= a.y.min(b.y) - EPS
        && p.y <= a.y.max(b.y) + EPS
}

fn segment_hit(a: Point, b: Point, c: Point, d: Point) -> bool {
    let o1 = orient(a, b, c);
    let o2 = orient(a, b, d);
    let o3 = orient(c, d, a);
    let o4 = orient(c, d, b);
    if ((o1 > EPS && o2 < -EPS) || (o1 < -EPS && o2 > EPS))
        && ((o3 > EPS && o4 < -EPS) || (o3 < -EPS && o4 > EPS))
    {
        return true;
    }
    (o1.abs() <= EPS && on_segment(a, b, c))
        || (o2.abs() <= EPS && on_segment(a, b, d))
        || (o3.abs() <= EPS && on_segment(c, d, a))
        || (o4.abs() <= EPS && on_segment(c, d, b))
}

fn segment_distance(a: Point, b: Point, p: Point) -> f64 {
    let vx = b.x - a.x;
    let vy = b.y - a.y;
    let length2 = vx * vx + vy * vy;
    if length2 <= EPS {
        return dist(a, p);
    }
    let mut t = ((p.x - a.x) * vx + (p.y - a.y) * vy) / length2;
    t = t.clamp(0.0, 1.0);
    dist(
        Point {
            x: a.x + t * vx,
            y: a.y + t * vy,
        },
        p,
    )
}

fn edge_distance(a: Point, b: Point, c: Point, d: Point) -> f64 {
    if segment_hit(a, b, c, d) {
        0.0
    } else {
        segment_distance(a, b, c)
            .min(segment_distance(a, b, d))
            .min(segment_distance(c, d, a))
            .min(segment_distance(c, d, b))
    }
}

fn ring_inside(p: Point, ring: &[Point]) -> bool {
    let mut inside = false;
    let mut j = ring.len() - 1;
    for i in 0..ring.len() {
        let a = ring[i];
        let b = ring[j];
        if on_segment(a, b, p) {
            return true;
        }
        if (a.y > p.y) != (b.y > p.y)
            && p.x < (b.x - a.x) * (p.y - a.y) / (b.y - a.y) + a.x
        {
            inside = !inside;
        }
        j = i;
    }
    inside
}

fn obstacle_inside(p: Point, obstacle: &Obstacle) -> bool {
    ring_inside(p, &obstacle.rings[0])
        && !obstacle.rings[1..].iter().any(|ring| ring_inside(p, ring))
}

#[cfg(test)]
fn clear_linear(a: Point, b: Point, obstacles: &[Obstacle], radius: f64) -> bool {
    for obstacle in obstacles {
        if obstacle_inside(a, obstacle) || obstacle_inside(b, obstacle) {
            return false;
        }
        for ring in &obstacle.rings {
            for i in 0..ring.len() {
                if edge_distance(a, b, ring[i], ring[(i + 1) % ring.len()]) <= radius + EPS {
                    return false;
                }
            }
        }
    }
    true
}

fn build_node(nodes: &mut Vec<BvhNode>, obstacles: &[Obstacle], mut ids: Vec<usize>) -> usize {
    let bbox = ids
        .iter()
        .map(|&i| obstacles[i].bbox)
        .reduce(BBox::union)
        .expect("BVH node cannot be empty");
    if ids.len() <= 8 {
        let index = nodes.len();
        nodes.push(BvhNode {
            bbox,
            left: None,
            right: None,
            obstacles: ids,
        });
        return index;
    }
    let split_x = bbox.extent_x() >= bbox.extent_y();
    ids.sort_unstable_by(|&a, &b| {
        let av = if split_x { obstacles[a].bbox.center_x() } else { obstacles[a].bbox.center_y() };
        let bv = if split_x { obstacles[b].bbox.center_x() } else { obstacles[b].bbox.center_y() };
        av.partial_cmp(&bv).unwrap_or(Ordering::Equal)
    });
    let mid = ids.len() / 2;
    let right_ids = ids.split_off(mid);
    let left = build_node(nodes, obstacles, ids);
    let right = build_node(nodes, obstacles, right_ids);
    let index = nodes.len();
    nodes.push(BvhNode {
        bbox,
        left: Some(left),
        right: Some(right),
        obstacles: Vec::new(),
    });
    index
}

fn clear_indexed(context: &Context, a: Point, b: Point, radius: f64) -> bool {
    let amount = radius + EPS;
    let query = BBox {
        min_x: a.x.min(b.x),
        min_y: a.y.min(b.y),
        max_x: a.x.max(b.x),
        max_y: a.y.max(b.y),
    }
    .expanded(amount);
    let Some(root) = context.root else { return true };
    let mut stack = [0usize; 64];
    let mut stack_len = 1usize;
    stack[0] = root;
    while stack_len != 0 {
        stack_len -= 1;
        let node_index = stack[stack_len];
        let node = &context.nodes[node_index];
        if !node.bbox.overlaps(query) {
            continue;
        }
        if node.left.is_none() {
            for &obstacle_index in &node.obstacles {
                let obstacle = &context.obstacles[obstacle_index];
                if !obstacle.bbox.overlaps(query) {
                    continue;
                }
                if obstacle_inside(a, obstacle) || obstacle_inside(b, obstacle) {
                    return false;
                }
                for ring in &obstacle.rings {
                    for i in 0..ring.len() {
                        if edge_distance(a, b, ring[i], ring[(i + 1) % ring.len()]) <= amount {
                            return false;
                        }
                    }
                }
            }
        } else {
            if let Some(left) = node.left {
                if stack_len >= stack.len() { return false; }
                stack[stack_len] = left;
                stack_len += 1;
            }
            if let Some(right) = node.right {
                if stack_len >= stack.len() { return false; }
                stack[stack_len] = right;
                stack_len += 1;
            }
        }
    }
    true
}

fn decode_context(input: &[f64]) -> Option<Context> {
    if input.len() < 3 { return None; }
    let obstacle_count = parse_integer(input[0], input.len())?;
    let ring_count = parse_integer(input[1], input.len())?;
    let point_count = parse_integer(input[2], input.len())?;
    if obstacle_count == 0 || ring_count == 0 || point_count == 0 { return None; }
    let expected = 3usize
        .checked_add(obstacle_count + 1)?
        .checked_add(ring_count + 1)?
        .checked_add(point_count.checked_mul(2)?)?;
    if expected != input.len() || ring_count < obstacle_count || point_count < ring_count * 3 { return None; }
    let obstacle_offsets = &input[3..3 + obstacle_count + 1];
    let ring_start = 3 + obstacle_count + 1;
    let ring_offsets = &input[ring_start..ring_start + ring_count + 1];
    let points_start = ring_start + ring_count + 1;
    let mut obstacle_indices = Vec::with_capacity(obstacle_count + 1);
    for &v in obstacle_offsets {
        obstacle_indices.push(parse_integer(v, ring_count)?);
    }
    let mut ring_indices = Vec::with_capacity(ring_count + 1);
    for &v in ring_offsets {
        ring_indices.push(parse_integer(v, point_count)?);
    }
    if obstacle_indices[0] != 0 || *obstacle_indices.last()? != ring_count
        || ring_indices[0] != 0 || *ring_indices.last()? != point_count
    { return None; }
    if obstacle_indices.windows(2).any(|w| w[0] >= w[1])
        || ring_indices.windows(2).any(|w| w[0] >= w[1])
    { return None; }
    for window in obstacle_indices.windows(2) {
        if window[1] - window[0] < 1 { return None; }
    }
    for window in ring_indices.windows(2) {
        if window[1] - window[0] < 3 { return None; }
    }
    let mut all_points = Vec::with_capacity(point_count);
    for pair in input[points_start..].chunks_exact(2) {
        if !finite_coord(pair[0]) || !finite_coord(pair[1]) { return None; }
        all_points.push(Point { x: pair[0], y: pair[1] });
    }
    let mut obstacles = Vec::with_capacity(obstacle_count);
    for oi in 0..obstacle_count {
        let first_ring = obstacle_indices[oi];
        let last_ring = obstacle_indices[oi + 1];
        let mut rings = Vec::with_capacity(last_ring - first_ring);
        let mut bbox_points = Vec::new();
        for ri in first_ring..last_ring {
            let first_point = ring_indices[ri];
            let last_point = ring_indices[ri + 1];
            let ring = all_points[first_point..last_point].to_vec();
            bbox_points.extend_from_slice(&ring);
            rings.push(ring);
        }
        obstacles.push(Obstacle { bbox: BBox::from_points(&bbox_points), rings });
    }
    let mut nodes = Vec::new();
    let root = Some(build_node(&mut nodes, &obstacles, (0..obstacles.len()).collect()));
    Some(Context { obstacles, nodes, root })
}

#[no_mangle]
pub extern "C" fn gds_alloc(len: u32) -> *mut f64 {
    let len = len as usize;
    if len > MAX_ALLOC || len == 0 { return ptr::null_mut(); }
    let mut values = vec![0.0f64; len].into_boxed_slice();
    let pointer = values.as_mut_ptr();
    std::mem::forget(values);
    pointer
}

#[no_mangle]
pub unsafe extern "C" fn gds_free(ptr: *mut f64, len: u32) {
    if ptr.is_null() || len == 0 || len as usize > MAX_ALLOC { return; }
    // SAFETY: the caller must pass the pointer and length returned by gds_alloc.
    drop(unsafe { Box::from_raw(std::ptr::slice_from_raw_parts_mut(ptr, len as usize)) });
}

#[no_mangle]
pub unsafe extern "C" fn gds_create(ptr: *const f64, len: u32) -> *mut Context {
    if ptr.is_null() || len == 0 || len as usize > MAX_ALLOC { return ptr::null_mut(); }
    // SAFETY: the caller must pass a readable f64 buffer of the declared length.
    let input = unsafe { std::slice::from_raw_parts(ptr, len as usize) };
    let Some(context) = decode_context(input) else { return ptr::null_mut(); };
    Box::into_raw(Box::new(context))
}

#[no_mangle]
pub unsafe extern "C" fn gds_destroy(ctx: *mut Context) {
    if !ctx.is_null() {
        // SAFETY: the caller must pass a context returned by gds_create exactly once.
        drop(unsafe { Box::from_raw(ctx) });
    }
}

#[no_mangle]
pub unsafe extern "C" fn gds_clear(
    ctx: *const Context,
    ax: f64,
    ay: f64,
    bx: f64,
    by: f64,
    radius: f64,
) -> u32 {
    if ctx.is_null()
        || !valid_query(ax)
        || !valid_query(ay)
        || !valid_query(bx)
        || !valid_query(by)
        || !radius.is_finite()
        || radius < 0.0
        || radius > COORD_LIMIT
    {
        return 0;
    }
    // SAFETY: the caller must pass a live context returned by gds_create.
    let context = unsafe { &*ctx };
    if radius + EPS > COORD_LIMIT { return 0; }
    if clear_indexed(context, Point { x: ax, y: ay }, Point { x: bx, y: by }, radius) { 1 } else { 0 }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn obstacle_data(obstacles: &[&[&[(f64, f64)]]]) -> Vec<f64> {
        let mut rings = Vec::new();
        let mut points = Vec::new();
        let mut obstacle_offsets = vec![0.0];
        let mut ring_offsets = vec![0.0];
        for obstacle in obstacles {
            for ring in *obstacle {
                for &(x, y) in *ring { points.extend([x, y]); }
                ring_offsets.push((points.len() / 2) as f64);
                rings.push(());
            }
            obstacle_offsets.push(rings.len() as f64);
        }
        let mut out = vec![obstacles.len() as f64, rings.len() as f64, (points.len() / 2) as f64];
        out.extend(obstacle_offsets);
        out.extend(ring_offsets);
        out.extend(points);
        out
    }

    fn context(data: &[f64]) -> Context { decode_context(data).unwrap() }

    #[test]
    fn holes_and_closed_or_open_rings_match_linear() {
        let outer = [(0.0, 0.0), (10.0, 0.0), (10.0, 10.0), (0.0, 10.0)];
        let hole = [(3.0, 3.0), (7.0, 3.0), (7.0, 7.0), (3.0, 7.0)];
        let data = obstacle_data(&[&[&outer, &hole]]);
        let c = context(&data);
        assert!(!clear_indexed(&c, Point { x: 1.0, y: 1.0 }, Point { x: 1.0, y: 1.0 }, 0.0));
        assert!(clear_indexed(&c, Point { x: 5.0, y: 5.0 }, Point { x: 5.0, y: 5.0 }, 0.0));
        assert_eq!(clear_linear(Point { x: 5.0, y: 5.0 }, Point { x: 5.0, y: 5.0 }, &c.obstacles, 0.0), true);
    }

    #[test]
    fn tangency_and_degenerate_segment_use_js_eps() {
        let square = [(2.0, -1.0), (4.0, -1.0), (4.0, 1.0), (2.0, 1.0)];
        let c = context(&obstacle_data(&[&[&square]]));
        let a = Point { x: 0.0, y: 0.0 };
        let b = Point { x: 6.0, y: 0.0 };
        assert!(!clear_indexed(&c, a, b, 0.0));
        assert!(!clear_indexed(&c, Point { x: 2.0, y: -1.0 }, Point { x: 2.0, y: -1.0 }, 0.0));
        assert!(clear_indexed(&c, Point { x: 0.0, y: 2.0 }, Point { x: 6.0, y: 2.0 }, 0.0));
    }

    #[test]
    fn indexed_queries_equal_linear_queries() {
        let a = [(0.0, 0.0), (2.0, 0.0), (2.0, 2.0), (0.0, 2.0)];
        let b = [(100.0, 100.0), (110.0, 100.0), (110.0, 110.0), (100.0, 110.0)];
        let c = context(&obstacle_data(&[&[&a], &[&b]]));
        for &(p, q, r) in &[
            ((-1.0, 1.0), (3.0, 1.0), 0.0),
            ((3.0, 3.0), (4.0, 4.0), 0.0),
            ((99.0, 105.0), (111.0, 105.0), 0.1),
        ] {
            let p = Point { x: p.0, y: p.1 };
            let q = Point { x: q.0, y: q.1 };
            assert_eq!(clear_indexed(&c, p, q, r), clear_linear(p, q, &c.obstacles, r));
        }
    }

    #[test]
    fn malformed_headers_are_rejected() {
        assert!(decode_context(&[1.0, 1.0, 3.0, 0.0, 1.0, 0.0, 3.0, 0.0, 0.0, 1.0]).is_none());
    }
}
