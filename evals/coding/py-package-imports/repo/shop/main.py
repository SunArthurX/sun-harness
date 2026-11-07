from pricing import order_total
from models import Line

if __name__ == "__main__":
    print(order_total([Line("tea", 3.5, 2), Line("cake", 4.25, 1)]))
